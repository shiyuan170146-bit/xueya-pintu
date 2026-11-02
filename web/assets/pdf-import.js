/* ============================================================
 * PDF 智能识别（教务系统导出的 PDF → 导入行）
 * 纯函数，不依赖 DOM：浏览器挂到 window.PdfImport，Node 里 module.exports
 *
 * 支持两种教务导出：
 *   1) 成绩单（已获得成绩）—— 双栏表格：课程名称 / 性质 / 学分 / 成绩
 *   2) 课表（正在修读）—— 7 天网格，格子里是【本】课程名☆ + 周次/教室/学分
 * ============================================================ */
(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.PdfImport = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const DAYS = ['星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日']
  /* 成绩单「性质」列可能出现的值（学校既有性质也有类别，混在一列里） */
  const NAT_VALUES = ['必修', '选修', '通识', '体育', '限选', '任选', '公选', '必修课', '选修课']

  /* pdf.js 的 item → 统一的 { s, x, y }
     注意：items 必须已经用 page.viewport.transform 变换过（旋转页会自动摆正），
     变换后的 transform[5] 就是自上而下的 y，不要再翻转一次。 */
  function normItems(page) {
    const out = []
    for (const it of (page.items || [])) {
      const s = String(it.str == null ? '' : it.str).replace(/\u00a0/g, ' ').trim()
      if (!s) continue
      const tr = it.transform || []
      const x = Number(tr[4]) || 0
      const y = Number(tr[5]) || 0
      out.push({ s, x, y, w: Number(it.width) || 0 })
    }
    return out
  }

  /* 按 y 聚类成「行」，行内按 x 排序 */
  function groupRows(items, tol) {
    const t = tol || 3.5
    const sorted = items.slice().sort((a, b) => a.y - b.y || a.x - b.x)
    const rows = []
    for (const it of sorted) {
      const last = rows[rows.length - 1]
      if (last && Math.abs(last.y - it.y) <= t) last.items.push(it)
      else rows.push({ y: it.y, items: [it] })
    }
    for (const r of rows) r.items.sort((a, b) => a.x - b.x)
    return rows
  }

  /* 成绩：数字 / 等级；带 # * △ 标记 */
  function parseScore(raw) {
    let s = String(raw == null ? '' : raw).trim()
    const flags = { noGp: false, retake: false, recognized: false }
    if (/[#＃]/.test(s)) flags.noGp = true
    if (/\*/.test(s)) flags.retake = true
    if (/[△]/.test(s)) flags.recognized = true
    s = s.replace(/[#＃*△\s]/g, '')
    if (s === '') return { score: '', level: '', ...flags }
    if (/^\d{1,3}(\.\d)?$/.test(s)) return { score: s, level: '', ...flags }
    const LV = { '合格': '60', '通过': '60', '优秀': '95', '良好': '85', '中等': '75', '及格': '65', '不及格': '50' }
    if (LV[s]) return { score: LV[s], level: s, ...flags }
    return { score: '', level: s, ...flags }
  }

  /* ---------- 成绩单 ---------- */
  /* 版面是「报纸式分栏」：左栏自上而下排完各学期，剩下的课程从右栏顶端续排，
     所以右栏属于左栏最后出现的那个学期（学校导出模板可印证：右栏课程都是最后一学期）。 */
  function parseTranscript(pages) {
    const recs = []
    let sem = ''
    for (const pg of pages) {
      const items = normItems(pg)
      if (!items.length) continue
      const rows = groupRows(items, 3.5)

      /* 表头锚点：一行里出现两次 性质 / 学分 / 成绩（左右两栏各一次） */
      let A = null
      for (const r of rows) {
        const natX = r.items.filter(i => i.s === '性质').map(i => i.x)
        const crX = r.items.filter(i => i.s === '学分').map(i => i.x)
        const scX = r.items.filter(i => i.s === '成绩').map(i => i.x)
        const nmX = r.items.filter(i => i.s === '课' || i.s === '课程名称').map(i => i.x)
        if (natX.length >= 2 && crX.length >= 2 && scX.length >= 2) {
          A = {
            natX: natX.sort((a, b) => a - b),
            crX: crX.sort((a, b) => a - b),
            scX: scX.sort((a, b) => a - b),
            nmX: nmX.sort((a, b) => a - b),
          }
          break
        }
      }
      if (!A) continue
      /* 左右两栏分界：左栏「成绩」列右边缘再往右一点点 */
      const splitX = A.scX[0] + 10

      const leftBlocks = [], rightBlocks = []
      for (const r of rows) {
        const lineTxt = r.items.map(i => i.s).join(' ')
        const sm = lineTxt.match(/(\d{4})\s*[-－]\s*(\d{4})\s*学年\s*第\s*([12])\s*学期/)
        if (sm) sem = sm[1] + '-' + sm[2] + '-' + sm[3]

        const body = r.items.filter(i =>
          !/^\d{4}\s*[-－]\s*\d{4}\s*学年$/.test(i.s) &&
          !/^第\s*[12]\s*学期$/.test(i.s) &&
          !/^\d{4}\s*[-－]\s*\d{4}\s*学年\s*第\s*[12]\s*学期$/.test(i.s))
        if (!body.length) continue
        const L = body.filter(i => i.x < splitX)
        const R = body.filter(i => i.x >= splitX)
        if (L.length) leftBlocks.push({ items: L, sem })
        if (R.length) rightBlocks.push({ items: R, sem: '' })
      }
      for (const b of leftBlocks) pushBlock(b.items, 0, b.sem)
      /* 右栏沿用左栏最后一个学期；若右栏自己有学期标题，则用它自己的 */
      const tailSem = leftBlocks.length ? leftBlocks[leftBlocks.length - 1].sem : sem
      for (const b of rightBlocks) pushBlock(b.items, 1, tailSem)

      function pushBlock(bi, idx, semVal) {
        if (!bi.length) return
        const natX = A.natX[idx], crX = A.crX[idx], scX = A.scX[idx]
        const nameAt = [], natAt = [], crAt = [], scAt = []
        for (const it of bi) {
          if (it.x < natX - 8) { nameAt.push(it); continue }
          /* 性质/学分/成绩 三列按最近的锚点归类（列宽很窄，用绝对边界会差之毫厘） */
          const d = [
            { k: 'n', v: Math.abs(it.x - natX) },
            { k: 'c', v: Math.abs(it.x - crX) },
            { k: 's', v: Math.abs(it.x - scX) },
          ].sort((a, b2) => a.v - b2.v)
          if (d[0].k === 'n') natAt.push(it)
          else if (d[0].k === 'c') crAt.push(it)
          else scAt.push(it)
        }
        const name = nameAt.map(i => i.s).join('').replace(/\s+/g, '')
        const nat = natAt.map(i => i.s).join('').replace(/\s+/g, '')
        const cr = crAt.map(i => i.s).join('').replace(/\s+/g, '')
        const sc = scAt.map(i => i.s).join('').replace(/\s+/g, '')
        if (!name) return
        if (!NAT_VALUES.some(v => nat.indexOf(v) === 0)) return
        if (!/^\d+(\.\d+)?$/.test(cr)) return
        if (!(Number(cr) >= 0.5 && Number(cr) <= 20)) return
        const ps = parseScore(sc)
        if (sc && !ps.score && !ps.level) return
        const cn = nat.indexOf('通识') === 0 ? '通识' : nat.indexOf('体育') === 0 ? '体育' : (nat.indexOf('必修') === 0 ? '必修' : '选修')
        recs.push({
          sem: semVal || '',
          name,
          credit: cr,
          score: ps.score,
          level: ps.level,
          nature: (cn === '通识' || cn === '体育') ? '选修' : cn,
          rawNature: cn,
          noGp: ps.noGp,
          retake: ps.retake,
        })
      }
    }
    return recs
  }

  /* ---------- 课表（正在修读） ---------- */
  function parseTimetable(pages) {
    let sem = ''
    let dayX = []
    const seen = new Map()
    for (const pg of pages) {
      const items = normItems(pg)
      if (!items.length) continue
      const allTxt = items.map(i => i.s).join('')
      const m = allTxt.match(/(\d{4})\s*[-－]\s*(\d{4})\s*学年\s*第\s*([12])\s*学期/)
      if (m) sem = m[1] + '-' + m[2] + '-' + m[3]

      const rows = groupRows(items, 3.5)
      /* 「其它课程」行：选了课但没有线下排课、不进网格，形如
         其它课程: 形势与政策（二）☆武装类(共18周)/2-19周/无;  （多门用「;」分隔，无学分信息）。
         它常出现在最后一页底部 —— 那页可能没有星期表头，所以必须在 dayX 判断之前解析 */
      const lineTxt = rows.map(r => r.items.map(i => i.s).join('')).join('\n')
      const oi = lineTxt.indexOf('其它课程')
      if (oi >= 0) {
        for (const seg of lineTxt.slice(oi + 4).split(/[;；\n]/)) {
          const marks = ['☆', '★', '○', '◇', '●', '◎'].map(ch => seg.indexOf(ch)).filter(x => x >= 0)
          if (!marks.length) continue
          const name = seg.slice(0, marks[0]).replace(/[\s\u3000]/g, '').replace(/^[:：]/, '')
          if (!name || name.length < 2) continue
          if (!seen.has(name)) seen.set(name, { sem: sem || '', name, credit: '', score: '', nature: '', rawNature: '' })
        }
      }

      let pageHeadMin = 0
      for (const r of rows) {
        const hit = r.items.filter(i => DAYS.indexOf(i.s) >= 0)
        if (hit.length >= 5) { dayX = hit.sort((a, b) => a.x - b.x).map(i => i.x); pageHeadMin = r.y + 6; break }
      }
      /* 第 2、3 页往往没有表头：沿用上一页的列坐标，且不再按表头高度裁剪 */
      if (!dayX.length) continue
      const W = Number(pg.width) || 900

      for (let d = 0; d < dayX.length; d++) {
        const x0 = dayX[d] - 2
        const x1 = d + 1 < dayX.length ? dayX[d + 1] - 2 : W + 1
        const cell = items.filter(i => i.x >= x0 && i.x < x1 && i.y > pageHeadMin)
        const lines = groupRows(cell, 3.5).map(r => r.items.map(i => i.s).join(''))
        /* 每格可能有多门课，以「【本】」为块起点 */
        const blocks = []
        let cur = null
        for (const ln of lines) {
          if (ln.indexOf('【本】') >= 0) {
            if (cur) blocks.push(cur)
            cur = ln
          } else if (cur) cur += '\n' + ln
        }
        if (cur) blocks.push(cur)

        for (const b of blocks) {
          const nm = b.match(/【本】([\s\S]*?)[☆★○◇●◎]/)
          let name = nm ? nm[1] : ''
          name = name.replace(/[\s\u3000]/g, '')
          if (!name || name.length < 2) continue
          /* 学分：块末的最后一个数字（格式 …/4./40/3.0） */
          const flat = b.replace(/\n/g, ' ')
          const tm = flat.match(/(\d+(?:\.\d+)?)\s*$/)
          let credit = tm ? tm[1] : ''
          if (credit && !(Number(credit) >= 0.5 && Number(credit) <= 20)) credit = ''
          if (!seen.has(name)) seen.set(name, { sem: sem || '', name, credit, score: '', nature: '', rawNature: '' })
        }
      }
    }
    return Array.from(seen.values())
  }

  /* 自动判定文件类型 */
  function detectKind(pages) {
    const txt = pages.map(pg => (pg.items || []).map(i => i.str || '').join('')).join('')
    if (/成绩单/.test(txt) && /学分/.test(txt)) return 'transcript'
    if (DAYS.some(d => txt.indexOf(d) >= 0)) return 'timetable'
    if (/正在修读|课表/.test(txt)) return 'timetable'
    return 'unknown'
  }

  return { parseTranscript, parseTimetable, detectKind, parseScore, normItems, groupRows }
})
