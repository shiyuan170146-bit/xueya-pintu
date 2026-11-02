/* ============================================================
 * 学涯拼图 · 前端逻辑
 * 面向对象：信息管理与信息系统专业在校学生（单角色站点）
 * 技术形态：纯 HTML/CSS/JS + WorkBuddy 云服务（数据库 / 账号）
 * 培养方案：内置只读数据 assets/plan-2023*.json（信管/工程管理/土地资源管理/行政管理）
 * ============================================================ */

/* ---------- 云服务初始化（publicConfig） ---------- */
const publicConfig = {
  endpoint: 'https://student-score-system-52023.app.workbuddy.host',
  oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth',
  publishableKey: 'wbpk_EFKeRvU1MON18EUPhHc1Zq_82IDxc5pz5CMzokA1HwWh9Rd1CRl3Ld2',
}
let cloud = null
function initCloud() {
  cloud = WorkBuddyCloud.createWorkBuddyCloud({
    endpoint: publicConfig.endpoint,
    oauthRelayBaseUrl: publicConfig.oauthRelayBaseUrl,
    publishableKey: publicConfig.publishableKey,
  })
  boot()
}
setTimeout(function waitSdk(n) {
  if (window.WorkBuddyCloud) return initCloud()
  if (n > 120) {
    document.body.innerHTML = '<div class="auth-wrap"><div class="auth-card"><h1>加载失败</h1><p class="auth-sub">服务组件加载失败，请检查网络后刷新重试。</p></div></div>'
    return
  }
  setTimeout(() => waitSdk(n + 1), 500)
}, 0)

/* ---------- 全局状态 ---------- */
const state = {
  profile: null,      // { role, real_name, student_id }
  page: null,
  cache: {},
  pendingOtp: null,
  forgotStarted: null,
  importDraft: null,  // 导入预览草稿（解析了但还没确认导入）——切页不丢，回来自动恢复
  planMajor: '',      // 当前用户的专业名（来自名册），决定加载哪份培养方案
  privacyMode: false, // 无绩点模式：导入时不读取/不存储分数与绩点（会话内记忆勾选状态）
}

/* ---------- 小工具 ---------- */
const $ = (id) => document.getElementById(id)
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v)
    else if (v !== null && v !== undefined) el.setAttribute(k, v)
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined) continue
    el.append(c.nodeType ? c : document.createTextNode(c))
  }
  return el
}
function toast(msg, type = '') {
  const t = $('toast')
  t.textContent = msg; t.className = 'toast ' + type
  clearTimeout(t._tm); t._tm = setTimeout(() => t.classList.add('hidden'), 2600)
}
function loading(on) { $('loading').classList.toggle('hidden', !on) }
function fmtScore(v) { return (v === null || v === undefined) ? '—' : Number(v) }
function n1(v) { return (Math.round(Number(v || 0) * 10) / 10).toFixed(1) }

async function guard(fn) {
  loading(true)
  try { return await fn() }
  catch (e) { console.error(e); toast(e.message || '操作失败', 'err') }
  finally { loading(false) }
}

/* 绩点换算（与数据库 score_to_gp 一致） */
function scoreToGp(s) {
  if (s === null || s === undefined || s === '') return null
  s = Number(s)
  if (s >= 90) return 4.0; if (s >= 85) return 3.7; if (s >= 82) return 3.3
  if (s >= 78) return 3.0; if (s >= 75) return 2.7; if (s >= 72) return 2.3
  if (s >= 68) return 2.0; if (s >= 64) return 1.5; if (s >= 60) return 1.0
  return 0.0
}

/* 通用弹窗：fields = [{key,label,type,value,options,required,placeholder}]；
   note 为可选的说明段落（纯文本，保留换行） */
function openModal({ title, note, fields = [], submitText = '确定', onSubmit }) {
  const box = $('modalBox')
  box.innerHTML = ''
  const form = h('form', { class: 'modal-form' })
  form.append(h('h3', {}, title))
  if (note) form.append(h('p', { class: 'modal-note' }, note))
  for (const f of fields) {
    const label = h('label', {}, f.label)
    let input
    if (f.type === 'select') {
      input = h('select', { id: 'm_' + f.key })
      for (const o of f.options) input.append(h('option', { value: o.value }, o.text || o.value))
      if (f.value !== undefined) input.value = f.value
    } else if (f.type === 'textarea') {
      input = h('textarea', { id: 'm_' + f.key, placeholder: f.placeholder || '' })
      if (f.value !== undefined) input.value = f.value
    } else {
      input = h('input', { id: 'm_' + f.key, type: f.type || 'text', placeholder: f.placeholder || '' })
      if (f.value !== undefined) input.value = f.value
    }
    label.append(input); form.append(label)
  }
  form.append(h('div', { class: 'modal-actions' },
    h('button', { type: 'button', class: 'btn', onclick: closeModal }, '取消'),
    h('button', { type: 'submit', class: 'btn primary' }, submitText),
  ))
  form.addEventListener('submit', (e) => {
    e.preventDefault()
    const values = {}
    let bad = false
    for (const f of fields) {
      const el = $('m_' + f.key)
      values[f.key] = el.value.trim()
      if (f.required && !el.value.trim()) { el.style.borderColor = 'var(--c-red)'; bad = true }
    }
    if (bad) { toast('请填写完整', 'err'); return }
    onSubmit(values)
  })
  box.append(form)
  $('modalMask').classList.remove('hidden')
}
function closeModal() { $('modalMask').classList.add('hidden') }

/* ---------- 数据库封装 ---------- */
async function dbSelect(table, { eq, inArr, order, ascending = true, limit } = {}) {
  let q = cloud.database.from(table).select('*')
  if (eq) for (const [k, v] of Object.entries(eq)) q = q.eq(k, v)
  if (inArr) q = q.in(inArr[0], inArr[1])
  if (order) q = q.order(order, { ascending })
  if (limit) q = q.limit(limit)
  const { data, error } = await q
  if (error) throw new Error(error.message || '查询失败')
  return data || []
}
async function dbRpc(fn, params) {
  const { data, error } = await cloud.database.rpc(fn, params)
  if (error) throw new Error(error.message || '调用失败')
  return data
}

/* ---------- CSV ---------- */
function downloadCSV(filename, rows) {
  const csv = '\uFEFF' + rows.map(r => r.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n')
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  a.download = filename; a.click(); URL.revokeObjectURL(a.href)
}
function parseCSVText(text) {
  text = String(text || '').replace(/^\uFEFF/, '')
  const rows = []; let row = [], cur = '', inQ = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++ } else inQ = false }
      else cur += ch
    } else if (ch === '"') inQ = true
    else if (ch === ',') { row.push(cur); cur = '' }
    else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(cur); cur = ''
      if (row.some(c => c.trim() !== '')) rows.push(row)
      row = []
    } else cur += ch
  }
  row.push(cur)
  if (row.some(c => c.trim() !== '')) rows.push(row)
  return rows
}
/* 读取文本文件：UTF-8 乱码（含替换符）时回退 GBK，兼容 Excel 直接另存的 CSV */
function readTextFile(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => {
      const text = String(r.result || '')
      if (text.includes('\uFFFD')) {
        const r2 = new FileReader()
        r2.onload = () => resolve(String(r2.result || '').replace(/^\uFEFF/, ''))
        r2.onerror = () => resolve(text)
        r2.readAsText(file, 'gbk')
        return
      }
      resolve(text.replace(/^\uFEFF/, ''))
    }
    r.onerror = () => reject(new Error('读取文件失败'))
    r.readAsText(file, 'utf-8')
  })
}

/* ---------- Excel（.xlsx）读写：模板下载 / 成绩单导入导出用 ---------- */
const HAS_XLSX = typeof XLSX !== 'undefined'

/* 生成并下载 .xlsx。sheets: [{ name, rows, cols }]；库缺失时降级成第一个表的 CSV */
function downloadXLSX(filename, sheets) {
  if (!HAS_XLSX) {
    const s = sheets[0] || { rows: [] }
    downloadCSV(String(filename).replace(/\.xlsx$/i, '.csv'), s.rows)
    toast('本地 Excel 组件未加载，已改存 CSV', 'err')
    return
  }
  const wb = XLSX.utils.book_new()
  for (const s of sheets) {
    const ws = XLSX.utils.aoa_to_sheet(s.rows)
    if (s.cols) ws['!cols'] = s.cols.map(w => ({ wch: w }))
    XLSX.utils.book_append_sheet(wb, ws, String(s.name).slice(0, 31))
  }
  XLSX.writeFile(wb, filename)
}

/* 读取上传的表格文件 → 二维数组。支持 .xlsx / .xls / .csv */
async function readTableRows(file) {  if (/\.(xlsx|xls|xlsm)$/i.test(file.name || '')) {
    if (!HAS_XLSX) throw new Error('本地 Excel 组件未加载，无法读取 .xlsx；请把文件另存为 CSV 后重试')
    const buf = await file.arrayBuffer()
    const wb = XLSX.read(buf, { type: 'array' })
    const name = wb.SheetNames.find(n => /导入|成绩/.test(n)) || wb.SheetNames[0]
    const json = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: false, defval: '', blankrows: false })
    return json.map(r => r.map(c => (c === null || c === undefined ? '' : String(c))))
  }
  return parseCSVText(await readTextFile(file))
}

/* ============================================================
 * PDF 智能识别（教务系统直接导出的成绩单 / 课表）
 * 真实用户不会先整理成模板，所以这里把两种导出件直接读成导入行
 * ============================================================ */
const HAS_PDF = () => (typeof pdfjsLib !== 'undefined') && (typeof PdfImport !== 'undefined')

async function readPdfRecs(file) {
  if (!HAS_PDF()) throw new Error('PDF 解析组件未加载，请刷新页面后重试')
  if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'assets/vendor/pdf.worker.min.js'
  }
  const buf = new Uint8Array(await file.arrayBuffer())
  const doc = await pdfjsLib.getDocument({
    data: buf,
    cMapUrl: 'assets/vendor/cmaps/',
    cMapPacked: true,
    isEvalSupported: false,
  }).promise
  const pages = []
  for (let i = 1; i <= doc.numPages; i++) {
    const p = await doc.getPage(i)
    const vp = p.getViewport({ scale: 1 })
    const tc = await p.getTextContent()
    pages.push({
      width: vp.width,
      height: vp.height,
      items: tc.items.map(it => ({ str: it.str, width: it.width, transform: pdfjsLib.Util.transform(vp.transform, it.transform) })),
    })
  }
  const kind = PdfImport.detectKind(pages)
  if (kind === 'transcript') return { kind, recs: PdfImport.parseTranscript(pages) }
  if (kind === 'timetable') return { kind, recs: PdfImport.parseTimetable(pages) }
  throw new Error('没认出这份 PDF：请上传教务系统导出的「成绩单」或「正在修读课表」')
}

/* PDF 识别结果 → 与 Excel 模板同构的二维数组（交给 parseCourseRows 统一处理） */
function pdfRecsToRows(recs) {
  const rows = [['学期', '课程名称', '学分', '成绩', '课程类别', '性质']]
  for (const r of recs) {
    /* 成绩单的「性质」列只有 必修 / 选修 / 通识 / 体育 这几种，它是「大体分类」的线索，
       不等于培养方案里的学分归属（体育A/B/C/D、通识任选到底算哪一类，得学生自己定）。
       所以类别列留空，性质列写原文，交给 parseCourseRows 决定自动归属还是给个推荐值。 */
    rows.push([r.sem || '', r.name, r.credit, r.score, '', r.rawNature || r.nature || ''])
  }
  return rows
}

/* 学校教务系统的课程类别 → 培养方案分类（别名映射，用于「分类归属」） */
const CAT_ALIAS = {
  '通识课程(任选)': '通识课程',
  '通识课程(指定选修)': '通识课程',
  '美育实践': '美育类课程',
  '志愿服务': '公共实践',
  '社会实践': '公共实践',
  '创新创业实践': '公共实践',
}
/* 统一写法：全角括号→半角、去空白与星号，便于比对 */
function normCatName(s) {
  return String(s || '').replace(/[（(]/g, '(').replace(/[）)]/g, ')').replace(/[＊*]/g, '').replace(/\s/g, '').trim()
}
/* 认定型实践课：不是「选课」，只作完成认定（美育实践/志愿服务/社会实践） */
function isPracticeCourse(n) {
  return /^(美育实践|志愿服务|社会实践)$/.test(String(n || '').replace(/\s/g, ''))
}
/* 模板「状态」列归一：完成/已修/已认定 → 完成；在修/再修 → 在修；其余不识别 */
function normTplState(s) {
  const v = String(s || '').replace(/\s/g, '')
  if (/^(完成|已修|已认定)$/.test(v)) return '完成'
  if (/^(在修|再修)$/.test(v)) return '在修'
  return ''
}

/* ---- 是否计入平均学分绩点 ----
   绝大多数课程计入；以下不计入：MOOC / 智慧树课、体育课、国际课程（项目）、
   创新创业实践、大学生创新创业基础、大学生心理素质拓展，以及本来就没写成绩（在修）的。
   默认一律按规则自动判定，用户可在导入预览和课程列表里逐条改。 */
const NO_GP_CATS = ['体育类课程', '国际课程（项目）']
const NO_GP_NAME_RE = /mooc|慕课|智慧树|创新创业实践|创新创业基础|心理素质拓展|体育|球类|游泳|健美操|体操|太极|田径/i
function autoCountGp(name, cat, score) {
  if (score === '' || score === null || score === undefined) return false
  if (NO_GP_NAME_RE.test(String(name || ''))) return false
  const c = normCatName(cat)
  if (c && NO_GP_CATS.some(x => normCatName(x) === c)) return false
  return true
}

/* 可作为「学分归属」的类别：叶节点 + 方案里实际被用作归属的类目（如「专业实践」）
   + 有学分要求但子类无学分要求的模块（如「开放性专业选修课程」27 学分，学生只报大类也用得上） */
function leafCatNames(plan) {
  const childOf = (code) => plan.cats.filter(c => c.parent_code === code)
  const names = plan.cats.filter(c => childOf(c.code).length === 0).map(c => c.name)
  for (const c of plan.courses) {
    const cat = plan.cats.find(x => x.code === c.category_code)
    if (cat && !names.includes(cat.name)) names.push(cat.name)
  }
  for (const c of plan.cats) {
    if (c.required_credits === null || c.required_credits === undefined) continue
    const kids = childOf(c.code)
    if (!kids.length) continue
    if (kids.some(k => k.required_credits !== null && k.required_credits !== undefined)) continue
    if (!names.includes(c.name)) names.push(c.name)
  }
  return names
}

/* 学校教务系统的课程类别 → 培养方案分类名称（同名优先 → 别名 → 去括号基名） */
function resolveCatName(plan, raw) {
  const n = normCatName(raw)
  if (!n) return ''
  const ok = leafCatNames(plan)
  let hit = ok.find(x => normCatName(x) === n)
  if (hit) return hit
  const alias = CAT_ALIAS[n]
  if (alias && ok.includes(alias)) return alias
  const base = n.replace(/\(.*?\)$/, '')
  hit = ok.find(x => normCatName(x) === base)
  return hit || ''
}

/* 表头识别：兼容学校模板列序（学期/课程名称/学分/课程类别/成绩）与旧 4 列（学期/课程名称/学分/成绩） */
const HEAD_RE = [
  ['sem', /学期|学年/],
  ['name', /课程名称|课程名/],
  ['credit', /学分/],
  ['score', /成绩|总评|分数/],
  ['cat', /课程类别|类别|分类/],
  ['nature', /课程性质|性质/],
  ['state', /状态/],
]
function mapHeadRow(row) {
  const map = {}
  for (let i = 0; i < row.length; i++) {
    const s = String(row[i] || '').replace(/\s/g, '')
    if (!s) continue
    for (const [k, re] of HEAD_RE) {
      if (map[k] === undefined && re.test(s)) { map[k] = i; break }
    }
  }
  return map
}
function cellAt(row, idx) {
  return idx === undefined ? '' : String(row[idx] ?? '').trim()
}

/* 培养方案列不全所有课，课名也常常差一两个字。所以归属只分三档：
   ① 方案原文里就有这门课 → 自动归属（课名基本是定死的）；
   ② 方案里没有，但「课程性质」本身就能说明大类（体育 / 通识 / 美育 / 劳育 / 军事）→ 只给推荐值，等学生点确认；
   ③ 性质和课名都看不出来（必修、选修、空）→ 不给推荐，学生自己选。
   guessCatByNature 实现第 ②档，返回值只用于下拉框里排在最前面的「推荐」项，绝不自动写入。 */
const NATURE_CAT_HINT = [
  [/体育|球类|游泳|健美操|田径|太极|体操|瑜伽|武术/, '体育类课程'],
  [/通识/, '通识课程'],
  [/美育/, '美育类课程'],
  [/劳育/, '劳育类课程'],
  [/军事/, '军事理论'],
]
/* 性质只写「必修 / 选修」时，课名本身还能看出大类的再兜一层（推荐值，仍需用户点确认） */
const NAME_CAT_HINT = [
  [/英语|外语|日语|德语|法语|俄语|韩语/, '外语类课程'],
  [/篮球|足球|排球|网球|羽毛球|乒乓球|游泳|健美操|体操|瑜伽|武术|太极|田径|体育/, '体育类课程'],
  [/绘画|书法|音乐|美术|艺术|美育/, '美育类课程'],
]
function guessCatByNature(plan, natureRaw, name) {
  const ok = leafCatNames(plan)
  const s = String(natureRaw || '')
  if (s) {
    for (const [re, cat] of NATURE_CAT_HINT) if (re.test(s) && ok.includes(cat)) return cat
  }
  const n = String(name || '')
  if (n) {
    for (const [re, cat] of NAME_CAT_HINT) if (re.test(n) && ok.includes(cat)) return cat
  }
  return ''
}
/* 性质归一：通识 / 体育 / 美育 / 劳育 在方案里都属于选修，写库时统一成选修 */
const NATURE_FIX = { '通识': '选修', '体育': '选修', '美育': '选修', '劳育': '选修' }

/* 把上传表格的二维数组解析成待导入条目（表头驱动，兼容学校模板列序） */
function parseCourseRows(plan, rows) {
  let map = null, start = 0
  for (let i = 0; i < Math.min(rows.length, 8); i++) {
    const m = mapHeadRow(rows[i])
    if (m.name !== undefined && (m.sem !== undefined || m.credit !== undefined)) { map = m; start = i + 1; break }
  }
  if (!map) {
    /* 没有可识别表头：按老约定位置读（学期/课程名称/学分/成绩[/课程类别/性质]） */
    map = { sem: 0, name: 1, credit: 2, score: 3, cat: 4, nature: 5 }
    start = (rows[0] && /学期/.test(String(rows[0][0] || ''))) ? 1 : 0
  }
  const list = []
  for (let i = start; i < rows.length; i++) {
    const r = rows[i]
    const name = cellAt(r, map.name)
    if (!name) continue
    if (/^注[:：]/.test(cellAt(r, map.sem)) || /^注[:：]/.test(name)) continue
    const credit = cellAt(r, map.credit)
    const score = cellAt(r, map.score)
    const catIn = cellAt(r, map.cat)
    const natureIn = cellAt(r, map.nature)
    const stateIn = cellAt(r, map.state)
    const sem = cellAt(r, map.sem).replace(/--+/g, '-')
    const pc = matchPlanCourse(plan, name, credit)
    let cat = resolveCatName(plan, catIn)
    let catAuto = false
    /* 类别兼容性：同名方案条目必须落在你填的类别（或它的上下级模块）里，才算「同一门课」；
       否则只是巧合同名（如「公共组织管理」方案里是交叉类选修，而学生选的是国际课程）。
       文件里的「课程类别」永远优先，同名不代表同一门课。 */
    const catOf = (code) => plan.cats.find(c => c.code === code)
    const catCompat = (p) => {
      if (!p) return false
      if (!cat) return true /* 没填类别：退回按方案类别处理 */
      const leaf = plan.cats.find(c => c.name === cat)
      if (!leaf) return false
      const pcat = p.category_code
      return pcat === leaf.code
        || catOf(pcat)?.parent_code === leaf.code
        || catOf(leaf.code)?.parent_code === pcat
    }
    /* 自动建档的课名（fromDb，来自别人导入示例/成绩时按类别自动入库）不是培养方案原文，
       只是「有人这么修过」的参考；任选类不是所有人都叫这些名字，
       不能当成官方课名跳过确认 —— 照样走「课名待确认」，核心归属看课程类别 */
    let official = pc && !pc.fromDb && catCompat(pc) ? pc : null
    /* 方案「原文」里有同名条目但类别对不上：只是巧合同名（如国际课程修的公共组织管理），
       提示用户但不按方案条目归类；fromDb 自动条目命中不算「同名他课」，走普通「按类别」 */
    const sameName = !!pc && !pc.fromDb && !official
    /* 教务课名与方案原文只差个别字眼（「Java程序设计」≈「JAVA语言程序设计」、「C语言」⊂「C语言程序设计」），
       而 fromDb 自动建档条目可能抢走 matchPlanCourse 的精确命中（byName 撞名直接 return），
       导致明明是同一门课却要用户手选类别。这里在方案原文（!fromDb）里再兜底找一次：
       归一化精确 → 宽松（去「语言/++/档位字母」）相等 → 归一化互相包含（取最长命中）。
       命中即直接判同一门课、自动按方案归类；名字有差异时界面标「名称近似」供核对，不用确认 */
    let fuzzyName = false
    if (!official && !cat) {
      const n0 = normName(name)
      const ln = looseName(name)
      let best = null, bestHit = -1
      for (const p of plan.courses) {
        if (p.fromDb || !catCompat(p)) continue
        const pn = normName(p.name)
        let hit = null
        if (pn === n0) hit = 99
        else if (ln.length >= 2 && looseName(p.name) === ln) hit = 90
        else if (pn.length >= 4 && (pn.includes(n0) || n0.includes(pn))) hit = Math.min(pn.length, n0.length)
        if (hit !== null && hit > bestHit) { best = p; bestHit = hit }
      }
      if (best) { official = best; fuzzyName = normName(best.name) !== n0 }
    }
    /* 只有培养方案原文里就有这门课才自动填类别。方案里没列、或只存在于「别人导入时按类别
       自动建档」的课（体育A/B/C/D、通识任选、开放性选修…），一律不擅自拍板，
       只给一个推荐值，让用户在预览里自己选 */
    if (!cat && official) {
      const pcat = catOf(official.category_code)
      if (pcat) { cat = pcat.name; catAuto = true }
    }
    /* 课表「其它课程」这类记录没有学分数字：匹配上方案原文课程时用方案学分兜底 */
    const creditOut = credit || (official ? String(official.credits) : '')
    /* 推荐值（不预选）：别人导入时按类别建档过 → 用那个类别；否则看课程性质推大类 */
    const catGuess = cat ? '' : (
      (pc && pc.fromDb && catOf(pc.category_code)?.name)
      || guessCatByNature(plan, natureIn, name)
      || ''
    )
    list.push({
      sem, name, credit: creditOut, score, cat, catAuto,
      nature: NATURE_FIX[natureIn] || natureIn || (official ? official.nature : '') || '必修',
      natureRaw: natureIn,
      /* 模板「状态」列：认定型实践课用它判定完成/在修；普通课只作校验提示 */
      state: normTplState(stateIn),
      stateIn,
      stateOk: stateIn === '' || !!normTplState(stateIn),
      planCode: official ? official.code : '',
      planName: official ? official.name : '',
      matched: !!official,
      fuzzy: fuzzyName,
      sameName: sameName && !!cat,
      sameNameCat: sameName ? (catOf(pc.category_code)?.name || '') : '',
      catIn,
      /* 类别没自动填上时的推荐值：只在下拉框里排第一并标「推荐」，需要用户点一下才算数 */
      catGuess,
      /* 课名不在培养方案原文里（含仅存在于自动建档的）：只需用户确认一下，不阻塞导入 */
      needConfirm: !official,
      confirmed: !!official,
      /* 是否计入绩点：按规则自动判定，用户可在预览里逐条改 */
      countGp: autoCountGp(name, cat, score),
      countGpAuto: true,
    })
  }
  return list
}

/* ============================================================
 * 登录 / 注册 / 忘记密码
 * ============================================================ */
function showView(name) {
  for (const v of ['loginView', 'appView']) $(v).classList.add('hidden')
  $(name).classList.remove('hidden')
}
function authMsg(msg, ok) { const m = $('authMsg'); m.textContent = msg; m.className = 'auth-msg ' + (ok ? 'ok' : 'err') }

/* 登录页三个视图（登录 / 注册 / 忘记密码）切换 + 底部跳转小字 */
function showAuthView(v) {
  const map = { login: ['formPwd', 'linksLogin'], otp: ['formOtp', 'linksOtp'], forgot: ['formForgot', 'linksForgot'] }
  for (const id of ['formPwd', 'formOtp', 'formForgot', 'linksLogin', 'linksOtp', 'linksForgot']) $(id).classList.add('hidden')
  for (const id of map[v] || map.login) $(id).classList.remove('hidden')
  authMsg('')
}
$('linkToOtp').addEventListener('click', () => showAuthView('otp'))
$('linkToForgot').addEventListener('click', () => showAuthView('forgot'))
$('linkBackLogin1').addEventListener('click', () => showAuthView('login'))
$('linkBackLogin2').addEventListener('click', () => showAuthView('login'))

$('formPwd').addEventListener('submit', async (e) => {
  e.preventDefault()
  await guard(async () => {
    /* 登录账号 = 邮箱（短信通道未开通，注册/登录只走邮箱） */
    const acc = $('pwdEmail').value.trim()
    if (!acc.includes('@')) return authMsg('请输入注册时使用的邮箱', false)
    const { error } = await cloud.auth.signInWithPassword({ email: acc, password: $('pwdPass').value })
    if (error) return authMsg('账号或密码错误', false)
    authMsg('登录成功，正在进入…', true)
    await afterLogin()
  })
})

function otpTarget() {
  const email = $('otpEmail').value.trim()
  if (!email) { authMsg('请先填写邮箱', false); return null }
  return { email, payload: { email }, label: '邮箱' }
}

$('btnSendOtp').addEventListener('click', async () => {
  await guard(async () => {
    const t = otpTarget()
    if (!t) return
    const sent = await cloud.auth.sendOtp(t.payload)
    if (sent.error) return authMsg(sent.error.message || '验证码发送失败', false)
    state.pendingOtp = { ...t, verificationId: sent.data.verificationId, isExistingUser: sent.data.isExistingUser }
    try { localStorage.setItem('pendingOtp', JSON.stringify(state.pendingOtp)) } catch (e) {}
    const isNew = !sent.data.isExistingUser
    $('otpSignup').classList.toggle('hidden', !isNew)
    /* 注册（无论邮箱还是手机号）都要设登录密码，之后统一用「账号 + 密码」登录 */
    /* 本机自建版没有邮件/短信通道，后端会把验证码直接回传（devCode）——
       这里显示出来并自动填入，方便本地演示；云端不返回该字段，逻辑不变。 */
    const devCode = sent.data && sent.data.devCode
    if (devCode) { $('otpCode').value = devCode; authMsg(`本机演示版验证码：${devCode}（已自动填入）`, true) }
    else authMsg(`验证码已发送，请查收${t.label}`, true)
    let n = 60; const btn = $('btnSendOtp'); btn.disabled = true
    const tm = setInterval(() => { btn.textContent = `${n--}s`; if (n < 0) { clearInterval(tm); btn.disabled = false; btn.textContent = '获取验证码' } }, 1000)
  })
})

$('formOtp').addEventListener('submit', async (e) => {
  e.preventDefault()
  await guard(async () => {
    let p = state.pendingOtp
    if (!p) { try { p = JSON.parse(localStorage.getItem('pendingOtp') || 'null') } catch (e) {} }
    if (!p) return authMsg('请先获取验证码', false)
    if (!p.email || p.email !== $('otpEmail').value.trim()) return authMsg('请先获取当前邮箱的验证码', false)

    const isNew = !p.isExistingUser
    const pass = $('otpPass').value

    /* 新流程：注册 = 邮箱 + 验证码 + 密码；学号在进入系统后于「绑定学生身份」面板绑定 */
    if (isNew && pass.length < 6) return authMsg('请设置至少 6 位的登录密码', false)

    const done = await cloud.auth.verifyOtp({
      email: p.email,
      verificationId: p.verificationId,
      isExistingUser: p.isExistingUser,
      token: $('otpCode').value.trim(),
      password: p.isExistingUser ? undefined : (pass || undefined),
    })
    if (done.error) return authMsg(done.error.message || '验证失败', false)
    state.pendingOtp = null
    try { localStorage.removeItem('pendingOtp') } catch (e) {}

    authMsg('登录成功，正在进入…', true)
    await afterLogin()
  })
})

$('btnFgSend').addEventListener('click', async () => {
  await guard(async () => {
    const email = $('fgEmail').value.trim()
    if (!email) return authMsg('请先填写邮箱', false)
    const started = await cloud.auth.resetPasswordForEmail(email)
    if (started.error) return authMsg(started.error.message || '发送失败', false)
    state.forgotStarted = { email, updateUser: started.data.updateUser }
    authMsg('重置验证码已发送', true)
  })
})

$('formForgot').addEventListener('submit', async (e) => {
  e.preventDefault()
  await guard(async () => {
    const f = state.forgotStarted
    if (!f || f.email !== $('fgEmail').value.trim()) return authMsg('请先发送重置验证码', false)
    if ($('fgNew').value.length < 6) return authMsg('新密码至少 6 位', false)
    const done = await f.updateUser({ nonce: $('fgCode').value.trim(), password: $('fgNew').value })
    if (done.error) return authMsg(done.error.message || '重置失败', false)
    state.forgotStarted = null
    authMsg('密码已重置并自动登录，正在进入…', true)
    await afterLogin()
  })
})

/* ============================================================
 * 应用外壳
 * ============================================================ */
const NAV = [
  { group: '我的学业' },
  { key: 'myProgress', label: '我的进度' },
  { key: 'myAdvice', label: '选课建议' },
  { key: 'myTimeline', label: '学期时间轴' },
  { group: '培养方案' },
  { key: 'myPlan', label: '查漏补缺' },
  { key: 'myPlanRead', label: '方案解读' },
  /* 「方案树状解读」（myPlanTree）与查漏补缺功能重复，按需隐藏入口；页面函数与 plan-tree.html 保留 */
  { group: '课程与成绩' },
  { key: 'myScores', label: '我的课程' },
  { group: '管理', adminOnly: true },
  { key: 'adminRoster', label: '名册管理', adminOnly: true },
  { key: 'adminUsers', label: '账号管理', adminOnly: true },
]

function enterApp() {
  const p = state.profile
  if (!p) { showView('loginView'); return }
  showView('appView')
  $('userName').textContent = p.real_name || ''
  $('userBadge').textContent = p.role === 'admin'
    ? (p.student_id ? '学号 ' + p.student_id + ' · 管理员' : '管理员')
    : p.student_id ? ('学号 ' + p.student_id) : '学生'
  /* 纯管理员（role=admin 且未绑学号）只做后台管理，侧栏精简为「管理」组，
     不显示学生端的学业页面（那些页面依赖学生身份/方案，对纯管理员无意义） */
  const pureAdmin = p.role === 'admin' && !p.student_id
  const sb = $('sidebar'); sb.innerHTML = ''
  for (const item of NAV) {
    if (item.adminOnly && p.role !== 'admin') continue
    if (pureAdmin && !item.adminOnly && item.key) continue
    if (item.group) {
      /* 纯管理员视角：跳过非管理的分组标题（其下入口已全部隐藏） */
      if (pureAdmin && item.adminOnly !== true) continue
      sb.append(h('div', { class: 'nav-group' }, item.group)); continue
    }
    const btn = h('button', { class: 'nav-item', 'data-key': item.key, onclick: () => goto(item.key) })
    const ic = h('span', { class: 'nav-ic' })
    ic.innerHTML = puzMini(NAV_HEX[item.key] || VIZ_C.leaf)
    btn.append(ic, h('span', { class: 'nav-label' }, item.label))
    sb.append(btn)
  }
  const first = NAV.find(i => i.key && (!pureAdmin || i.adminOnly))
  goto(first ? first.key : 'myProgress')
  const foot = h('div', { class: 'nav-foot' },
    h('b', {}, '2023 版培养方案'),
    h('span', {}, '毕业最低 151 学分 · 实践 45 学分'))
  sb.append(foot)
}

/* ---------- 重绘时保持滚动位置 ----------
   页面数据刷新（改分、改绩点、增删课程等）会整块重绘 DOM，浏览器默认把滚动条弹回顶部，
   用户会“被甩”回页面开头。这里在重绘前记住位置、重绘后恢复，视线不被打断。
   keepScroll(fn) 用于「原地重绘」；切页导航的保持逻辑在 goto() 里。 */
function keepScroll(fn) {
  const y = window.scrollY
  fn()
  const back = () => window.scrollTo(0, y)
  back()
  requestAnimationFrame(() => { back(); requestAnimationFrame(back) })
}

let gotoSeq = 0
/* goto(key, anchor)：切换/刷新页面。
   · 新页面先在隐藏容器里构建（旧页面保持可见），就绪后一次性原子替换 —— 消除切换时的白屏闪烁；
     页面导航也不再弹全屏「加载中」，只有按钮级操作（保存/删除等）才用 guard 的 loading。
   · anchor：跨页跳转到具体数据（[data-anchor="…"]），定位后高亮闪烁提示。 */
function goto(key, anchor) {
  const samePage = state.page === key
  const keepY = samePage ? window.scrollY : 0
  state.page = key
  const my = ++gotoSeq
  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.key === key))
  const host = $('main')
  const mount = document.createElement('div')
  mount.style.display = 'none'
  host.append(mount)
  ;(async () => {
    try { await PAGES[key]?.(mount) }
    catch (e) { console.error(e); toast(e.message || '页面加载失败', 'err'); mount.remove(); return }
    if (my !== gotoSeq) { mount.remove(); return }
    while (host.firstChild) host.firstChild.remove()
    mount.style.display = ''
    host.append(mount)
    const target = anchor ? mount.querySelector('[data-anchor="' + anchor + '"]') : null
    if (target) {
      requestAnimationFrame(() => {
        target.scrollIntoView({ block: 'center' })
        target.classList.add('anchor-flash')
        setTimeout(() => target.classList.remove('anchor-flash'), 1800)
      })
    } else {
      if (anchor) toast('没有找到对应的记录', 'err')
      /* 等布局稳定后再定位，避免被随后插入的内容顶掉 */
      const back = () => window.scrollTo(0, keepY)
      back()
      requestAnimationFrame(() => { back(); requestAnimationFrame(back) })
    }
  })()
}

$('btnLogout').addEventListener('click', async () => {
  await guard(async () => {
    await cloud.auth.signOut()
    state.profile = null
    state.cache = {}
    planCache = null
    state.planMajor = ''
    state.importDraft = null
    showView('loginView')
    showAuthView('login')   // 回到默认的账号密码界面
  })
})

/* ============================================================
 * 培养方案数据层（内置 JSON，只读）
 * ============================================================ */
let planCache = null
/* 多专业：按专业名映射方案文件（信管为默认/兜底） */
function planFileFor(majorHint) {
  const m = String(majorHint || '')
  if (m.includes('工程管理')) return 'plan-2023-gc.json'
  if (m.includes('土地资源管理')) return 'plan-2023-td.json'
  if (m.includes('行政管理')) return 'plan-2023-xz.json'
  return 'plan-2023.json'
}
async function loadPlan(majorHint) {
  const file = planFileFor(majorHint ?? state.planMajor)
  if (planCache && planCache.__file === file) return planCache
  const res = await fetch('assets/' + file, { cache: 'no-cache' })
  if (!res.ok) throw new Error('培养方案数据加载失败，请刷新重试')
  const raw = await res.json()
  const byCode = {}
  const byName = {}
  for (const p of raw.courses) {
    byCode[p.code] = p
    byName[normName(p.name)] = p
  }
  /* 便于按课名匹配：把「（一）」这类后缀归一化，兼容教务系统的不同写法 */
  planCache = { ...raw, byCode, byName, __file: file }
  /* 合并云库 plan_courses：导入时名称对不上方案的课程，后端已按「课程类别」自动建档
     （如 MOOC 通识课、球类体育课、中级英语）。查漏补缺的核心依据是课程类别，
     这些课同样要参与学分归属，不能因为内置 JSON 里没有就当成「方案外」。 */
  try {
    const dbRows = await dbSelect('plan_courses')
    const add = []
    for (const r of (dbRows || [])) {
      if (!r || !r.code || byCode[r.code]) continue
      if (!r.category_code || !raw.cats.some(c => c.code === r.category_code)) continue
      const p = {
        code: r.code, name: r.name, credits: Number(r.credits) || 0,
        sem_from: Number(r.sem_from) || 1, sem_to: Number(r.sem_to) || 8,
        category_code: r.category_code, nature: r.nature || '选修',
        is_generic: true, fromDb: true,
      }
      byCode[p.code] = p
      const nk = normName(p.name)
      if (!byName[nk]) byName[nk] = p
      add.push(p)
    }
    if (add.length) planCache.courses = raw.courses.concat(add)
  } catch (e) { /* plan_courses 读不到时退回内置方案，不影响其余功能 */ }
  return planCache
}
/* 课名归一化：去空格/＊、括号统一、全角转半角；
   罗马数字（ⅠⅡ…）与希腊字母异形（Ι）、中文数字（一二三…）统一成阿拉伯数字，
   避免「会计学（Ⅰ）」vs「会计学（Ι）」这种同课异形匹配不上 */
function normName(s) {
  const CN_NUM = '一二三四五六七八九'
  return String(s || '')
    .replace(/[\s\u3000＊*]/g, '')
    .replace(/[（(]/g, '(').replace(/[）)]/g, ')')
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩⅪⅫ]/g, c => 'ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩⅪⅫ'.indexOf(c) + 1)
    .replace(/[ⅰⅱⅲⅳⅴⅵⅶⅷⅸⅹⅺⅻ]/g, c => 'ⅰⅱⅲⅳⅴⅵⅶⅷⅸⅹⅺⅻ'.indexOf(c) + 1)
    .replace(/[Ιι]/g, '1')
    .replace(new RegExp('[' + CN_NUM + ']', 'g'), c => CN_NUM.indexOf(c) + 1)
    .replace(/[·•・]/g, '')
    .toLowerCase()
}
/* 更宽松的归一化：只在「严格匹配对不上」时再试一次。
   去掉「++」（C++语言程序设计 ≡ C语言程序设计）、去掉「语言」（Java程序设计 ≡ JAVA语言程序设计）、
   去掉末尾档位字母（数学建模B ≡ 数学建模）。只用于课名，不用于类别 */
function looseName(s) {
  return normName(s)
    .replace(/＋＋|\+\+/g, '')
    .replace(/语言/g, '')
    .replace(/([a-d])(?=\(|$)/g, '')
}
/* 把教务系统的课名匹配到培养方案课程（精确 → 归一化 → 互相包含取最长 → 宽松归一化） */
function matchPlanCourse(plan, name, credit) {
  const n = normName(name)
  if (!n) return null
  if (plan.byName[n]) return plan.byName[n]
  let best = null
  for (const p of plan.courses) {
    const pn = normName(p.name)
    if (pn === n) return p
    if (pn.length >= 4 && (pn.includes(n) || n.includes(pn))) {
      const scoreLen = Math.min(pn.length, n.length)
      if (!best || scoreLen > best.len) best = { p, len: scoreLen }
    }
  }
  if (best) return best.p
  /* 宽松再试一次：课名里的「++」「语言」「档位字母」差异不算差异 */
  const ln = looseName(name)
  if (ln.length >= 4) {
    let best2 = null
    for (const p of plan.courses) {
      const pn = looseName(p.name)
      if (pn === ln) return p
      if (pn.length >= 5 && (pn.includes(ln) || ln.includes(pn))) {
        const scoreLen = Math.min(pn.length, ln.length)
        if (!best2 || scoreLen > best2.len) best2 = { p, len: scoreLen }
      }
    }
    if (best2) return best2.p
  }
  /* 学分也对得上的话，放宽到 3 字前缀 */
  if (credit) {
    for (const p of plan.courses) {
      const pn = normName(p.name)
      if (pn.slice(0, 3) === n.slice(0, 3) && Number(p.credits) === Number(credit)) return p
    }
  }
  return null
}

/* ============================================================
 * 学业分析核心：把我的成绩映射到培养方案
 * ============================================================ */
function loadContext() {
  return dbSelect('courses').then(courses => dbSelect('course_arrangements').then(arrangements => ({ courses, arrangements })))
}
function joinScore(row, ctx) {
  const a = ctx.arrangements.find(x => x.arrange_id === row.arrange_id)
  const c = a ? ctx.courses.find(x => x.course_id === a.course_id) : null
  return { ...row, arrangement: a, course: c }
}
async function loadMyScores(ctx) {
  const scores = await dbSelect('scores', { order: 'score_id' })
  return scores.filter(s => s.student_id === state.profile.student_id).map(s => {
    const j = joinScore(s, ctx)
    /* 库里 gp 可能为空（历史数据 / 直接导入），按总评就地换算，保证绩点统计可用 */
    if ((j.gp === null || j.gp === undefined) && j.total_score !== null && j.total_score !== undefined) {
      j.gp = scoreToGp(j.total_score)
    }
    return j
  })
}

function analyzePlan(plan, mine) {
  const cats = plan.cats, courses = plan.courses
  const childOf = (code) => cats.filter(c => c.parent_code === code).sort((a, b) => a.sort - b.sort)
  const ownOf = (code) => courses
    .filter(p => p.category_code === code)
    .sort((a, b) => a.sem_from - b.sem_from || String(a.code).localeCompare(String(b.code)))
  const hasReq = (c) => c.required_credits !== null && c.required_credits !== undefined
  const isElective = (p) => p.nature === '选修' && !p.is_generic

  /* ---- 成绩 → 方案条目状态 ---- */
  /* 认定型实践课（美育实践/志愿服务/社会实践）：成绩栏永远为空，
     是否完成看 scores.status —— 导入模板「状态」写「完成」时后端存为「正常」 */
  const isPracticeName = isPracticeCourse
  const attempted = new Set(), passedSet = new Set(), inProgress = new Set()
  /* 已精确归属到某条方案条目的成绩（byCode / byName 命中）：一条成绩只算一处，
     不再参与同名兜底 —— 如「公共组织管理」修在国际课程（项目）类，
     管理与交叉融合类里的同名方案条目只是名字巧合，应显示未修而不是已修 */
  const attributed = new Set()
  const earned = {}, progressing = {}, countedCourses = new Set(), countedProg = new Set()
  const failMap = {}, extraCourses = [], gradeMap = {}
  /* 通识（GE 子树）里 MOOC 网课最多计 2 学分，超出的不计入通识学分：
     主循环里顺带统计已获 MOOC 学分，循环结束后从 earned 扣回超额部分 */
  const MOOC_CAP = 2
  const isMoocName = (n) => /mooc|慕课/i.test(String(n || ''))
  const geCodes = (() => {
    const acc = []
    const walk = (code) => { acc.push(code); for (const ch of childOf(code)) walk(ch.code) }
    walk('GE')
    return new Set(acc)
  })()
  let moocGot = 0
  const moocByCat = {}
  for (const s of mine) {
    const cname = s.course?.course_name
    const pc = plan.byCode[s.course?.plan_code || s.course?.course_id] || (cname ? matchPlanCourse(plan, cname, s.course?.credit) : null)
    if (!pc) {
      if (s.course && s.total_score !== null && Number(s.total_score) >= 60) extraCourses.push(s)
      continue
    }
    attempted.add(pc.code)
    attributed.add(s)
    if (!gradeMap[pc.code] || Number(s.total_score) > Number(gradeMap[pc.code].total_score ?? -1)) gradeMap[pc.code] = s
    const ckey = s.course?.course_id || ('arr' + s.arrange_id)
    /* 「已完成但无成绩」：认定型实践课 / 无绩点模式导入的已结业课 —— 学分计入已获，不算在修 */
    const noScoreDone = s.total_score === null && s.status !== '在修'
    if (s.status === '在修' || (s.total_score === null && !noScoreDone)) {
      if (!countedProg.has(ckey)) {
        countedProg.add(ckey); inProgress.add(pc.code)
        progressing[pc.category_code] = (progressing[pc.category_code] || 0) + Number(s.course?.credit ?? pc.credits)
      }
      continue
    }
    if (noScoreDone || Number(s.total_score) >= 60) {
      passedSet.add(pc.code)
      delete failMap[ckey]
      if (!countedCourses.has(ckey)) {
        countedCourses.add(ckey)
        const cred = Number(s.course?.credit ?? pc.credits)
        earned[pc.category_code] = (earned[pc.category_code] || 0) + cred
        if (isMoocName(cname) && geCodes.has(pc.category_code)) {
          moocGot += cred
          moocByCat[pc.category_code] = (moocByCat[pc.category_code] || 0) + cred
        }
      }
    } else if (!countedCourses.has(ckey)) {
      failMap[ckey] = pc.code
    }
  }
  /* 通识 MOOC 上限：超出 2 学分的部分从所在类目的已获学分里扣回 */
  let moocOver = moocGot - MOOC_CAP
  if (moocOver > 0) {
    for (const [cat, sum] of Object.entries(moocByCat)) {
      if (moocOver <= 0) break
      const cut = Math.min(moocOver, sum)
      earned[cat] = (earned[cat] || 0) - cut
      moocOver -= cut
    }
  }
  const failedSet = new Set(Object.values(failMap))
  /* 同名兜底表：课名（归一化，含罗马/希腊/中文数字异形统一）→ 最好的一次成绩。
     直接复用全局 normName（analyzePlan 内不再另设简化版），
     用于方案条目没直接挂到成绩时的状态判定（导入误建重复条目/异形字的情况），不参与学分计算。
     只收「没归属到任何方案条目」的成绩：已归属的成绩一条只算一处，
     别的类目里同名方案条目不算已修（名字重合 ≠ 修的是这门） */
  const nameScore = {}
  for (const s of mine) {
    if (attributed.has(s)) continue
    const nk = normName(s.course?.course_name)
    if (nk && (!nameScore[nk] || Number(s.total_score) > Number(nameScore[nk].total_score ?? -1))) nameScore[nk] = s
  }
  const failedList = []
  for (const s of mine) {
    const cname = s.course?.course_name
    const pc = plan.byCode[s.course?.plan_code || s.course?.course_id] || (cname ? matchPlanCourse(plan, cname, s.course?.credit) : null)
    if (!pc) continue
    if (s.total_score !== null && Number(s.total_score) < 60 && failedSet.has(pc.code)) failedList.push({ s, pc })
  }

  /* 同名兜底：方案条目没直接挂到成绩，但学生有同名课的记录 —— 已选(在修)/已修不算未修 */
  const nameStatusOf = (p) => {
    const ns = nameScore[normName(p.name)]
    if (!ns) return null
    if (ns.status === '在修') {
      return { k: 'doing', t: '在修', cls: 'blue' }
    }
    if (ns.total_score === null || ns.total_score === undefined || Number(ns.total_score) >= 60) return { k: 'pass', t: '已修', cls: 'green' }
    return null
  }

  /* 类别优先（核心口径）：学生记录挂在「通用要求项」上时（方案按课程类别认定、不点名具体课），
     同类别里还没配到成绩的「必修」具体条目由它来顶 —— 判据是课程类别，不是课名。
     选修槽位不被顶：选课池里没选的课仍是可选项（灰色可选），学生要看表知道还能选哪些。
     只影响状态与列表显示，不重复计学分 */
  const borrowedMap = {}
  {
    const slots = plan.courses.filter(p => !p.fromDb && !p.is_generic && p.nature !== '选修'
      && !gradeMap[p.code] && !passedSet.has(p.code) && !inProgress.has(p.code) && !failedSet.has(p.code)
      && !nameScore[normName(p.name)])
      .sort((a, b) => a.sem_from - b.sem_from || String(a.code).localeCompare(String(b.code)))
    const floats = []
    for (const s of mine) {
      const pc = plan.byCode[s.course?.plan_code || s.course?.course_id]
      if (!pc || !pc.is_generic) continue
      /* 在修 / 已完成无成绩（隐私·认定）/ 已通过 都参与顶槽；不及格不顶 */
      if (!(s.status === '在修' || s.total_score === null || s.total_score === undefined || Number(s.total_score) >= 60)) continue
      floats.push({ s, cat: pc.category_code })
    }
    const used = new Set()
    for (const p of slots) {
      const f = floats.find(x => !used.has(x.s) && x.cat === p.category_code)
      if (!f) continue
      used.add(f.s)
      borrowedMap[p.code] = f.s
    }
  }
  const borrowStatusOf = (p) => {
    if (p.nature === '选修') return null /* 选修槽位不被顶：可选状态留给选课池展示 */
    const b = borrowedMap[p.code]
    if (!b) return null
    if (b.status === '在修') return { k: 'doing', t: '在修', cls: 'blue' }
    return { k: 'pass', t: '已修', cls: 'green' }
  }

  /* 沿类别树向上找最近的带学分要求节点（供占位课判定用） */
  function catInfoUp(code) {
    let cur = cats.find(c => c.code === code)
    while (cur) {
      if (catProg[cur.code]) return catProg[cur.code]
      cur = cur.parent_code ? cats.find(c => c.code === cur.parent_code) : null
    }
    return null
  }

  const statusOf = (p) => {
    if (failedSet.has(p.code)) return { k: 'fail', t: '不及格', cls: 'red' }
    if (passedSet.has(p.code)) return { k: 'pass', t: '已修', cls: 'green' }
    if (inProgress.has(p.code)) return { k: 'doing', t: '在修', cls: 'blue' }
    /* 类别优先：同类别通用要求项上的记录顶上（如「常见动物中毒…」→「创新创业实践」） */
    const bs = borrowStatusOf(p)
    if (bs) return bs
    /* 同名课记录兜底（成绩挂在别处/重复条目上时，未修判定不能误报） */
    const ns = nameStatusOf(p)
    if (ns) return ns
    /* 别的同学导入后自动建档的课程：在你这里只是「可以这么修」的参考，不算未修 */
    if (p.fromDb) return { k: 'opt', t: '可选', cls: 'gray' }
    /* 「任选」占位课（如 通识选修（任选）5 学分）：所属类别学分已修满即视为已修，
       依据是课程类别而不是具体课名 —— 培养方案不可能列全所有课 */
    if (p.is_generic && p.nature === '选修') {
      const info = catInfoUp(p.category_code)
      if (info && info.rest === 0) return { k: 'pass', t: '已修', cls: 'green' }
    }
    /* 「按类别认定」的必修占位条目（如 大学外语（一）～（四）只是 4 个槽位）：
       类别学分已经实修达标，没挂成绩的槽位不算未修 —— 学生用任何同类课程顶上都行 */
    if (p.is_generic && p.nature === '必修') {
      const info = catInfoUp(p.category_code)
      if (info && info.got >= info.req) return { k: 'pass', t: '已修', cls: 'green' }
    }
    if (isElective(p)) return { k: 'opt', t: '可选', cls: 'gray' }
    return { k: 'todo', t: '未修', cls: 'red' }
  }

  /* ---- 层级学分聚合 ---- */
  const subtreeOf = (code) => {
    const acc = []
    const walk = (cd) => { acc.push(cd); for (const ch of childOf(cd)) walk(ch.code) }
    walk(code)
    return acc
  }
  const subtreeSum = (map, code) => subtreeOf(code).reduce((s, cd) => s + (map[cd] || 0), 0)
  /* 聚合：本级条目的学分 + 没有独立学分要求的子类（如 公共实践→创新创业实践）上浮计入；
     有独立要求的子类（如 专业实践→指定选修/配套实验）不重复算进父类，各自单独达标 */
  const effSum = (map, c) => (map[c.code] || 0)
    + childOf(c.code).filter(ch => !hasReq(ch)).reduce((s, ch) => s + effSum(map, ch), 0)

  const catProg = {}
  /* 递归计算（先子后父）：若某父类的子类学分要求之和正好等于父类要求
     （如 公共基础课程 26 = 外语 8 + 数学 14 + 信息科技 2 + 军事 2；
       体美劳育 6 = 体育 4 + 美育 2 + 劳育 0[不单独计学分，只认学时]），
     它就是「纯汇总行」——课程都挂在子类上，本级 earned 恒为 0，
     直接用 effSum 会显示「已获 0 / 还差 N」误导人；这种父类的数字改为子类之和
     （有要求的子类用各自达标数，无要求的子类照旧上浮），其余类目维持原口径 */
  const calcCat = (c) => {
    if (catProg[c.code]) return catProg[c.code]
    if (!hasReq(c)) { catProg[c.code] = null; return null }
    const req = Number(c.required_credits)
    const kids = childOf(c.code)
    const sumKids = kids.reduce((s, x) => s + Number(x.required_credits || 0), 0)
    let got, prog
    if (kids.length > 0 && sumKids === req) {
      got = earned[c.code] || 0
      prog = progressing[c.code] || 0
      for (const k of kids) {
        const kp = hasReq(k) ? calcCat(k) : null
        if (kp) { got += kp.got; prog += kp.prog }
        else { got += effSum(earned, k); prog += effSum(progressing, k) }
      }
      got = Math.min(got, req)
      prog = Math.min(prog, Math.max(0, req - got))
    } else {
      got = Math.min(effSum(earned, c), req)
      prog = Math.min(effSum(progressing, c), Math.max(0, req - got))
    }
    catProg[c.code] = { req, got, prog, rest: Math.max(0, req - got - prog) }
    return catProg[c.code]
  }
  cats.forEach(calcCat)
  const catDeficit = (code) => {
    let cur = cats.find(c => c.code === code)
    while (cur) {
      if (catProg[cur.code]) return catProg[cur.code].rest > 0
      cur = cur.parent_code ? cats.find(c => c.code === cur.parent_code) : null
    }
    return true
  }

  /* ---- 要求行（总学分 151 的口径，与培养方案一致） ---- */
  const reqRowCodes = new Set()
  function collectRows(c) {
    const childRows = childOf(c.code).flatMap(collectRows)
    const own = ownOf(c.code).length
    const sumChild = childRows.reduce((s, x) => s + Number(x.required_credits || 0), 0)
    let rows
    if (hasReq(c) && own === 0 && childRows.length > 0 && sumChild === Number(c.required_credits)) rows = childRows
    else if (hasReq(c)) rows = [c, ...childRows]
    else rows = childRows
    rows.forEach(r => reqRowCodes.add(r.code))
    return rows
  }
  const roots = cats.filter(c => !c.parent_code).sort((a, b) => a.sort - b.sort)
  roots.forEach(collectRows)
  const reqRows = cats.filter(c => reqRowCodes.has(c.code)).sort((a, b) => a.sort - b.sort)
  const subReqNames = (c) => {
    /* 只列有独立学分要求的子类；无要求的分组子类（如 创新创业实践）是本级的一部分，不单列 */
    const kids = childOf(c.code).filter(x => reqRowCodes.has(x.code) && hasReq(x))
    if (!kids.length) return []
    if (hasReq(c) && kids.reduce((s, x) => s + Number(x.required_credits || 0), 0) === Number(c.required_credits)) return []
    return kids.map(x => `「${x.name}」${Number(x.required_credits)} 学分`)
  }
  const totalReq = reqRows.reduce((s, c) => s + Number(c.required_credits || 0), 0)
  const totalGot = reqRows.reduce((s, c) => s + (catProg[c.code]?.got || 0), 0)
  const totalProg = reqRows.reduce((s, c) => s + (catProg[c.code]?.prog || 0), 0)
  const totalRest = reqRows.reduce((s, c) => s + (catProg[c.code]?.rest || 0), 0)

  return {
    plan, cats, courses, childOf, ownOf, hasReq, isElective, statusOf, catDeficit,
    attempted, passedSet, inProgress, failedSet, failedList, gradeMap, extraCourses, borrowedMap,
    earned, progressing, catProg, reqRows, roots, subReqNames,
    totalReq, totalGot, totalProg, totalRest,
    subtreeOf, subtreeSum, effSum,
  }
}

/* 学期工具 */
function currentTerm() {
  const d = new Date(), y = d.getFullYear(), m = d.getMonth() + 1
  if (m >= 9) return `${y}-${y + 1}-1`
  if (m <= 2) return `${y - 1}-${y}-1`
  return `${y - 1}-${y}-2`
}
function termToSem(term, enrollYear) {
  const m = /^(\d{4})-\d{4}-(\d)$/.exec(term || '')
  if (!m || !enrollYear) return null
  return (Number(m[1]) - Number(enrollYear)) * 2 + (m[2] === '1' ? 1 : 2)
}
/* 学期号（1–8）→ 学期字符串（如 2024-2025-1）；与 termToSem 互为反函数 */
function semToTerm(sem, enrollYear) {
  if (!enrollYear || !(sem >= 1 && sem <= 8)) return null
  const y0 = Number(enrollYear) + Math.floor((sem - 1) / 2)
  return `${y0}-${y0 + 1}-${(sem % 2 === 1) ? 1 : 2}`
}
function semLabel(pc) {
  return pc.sem_from === pc.sem_to ? `第${pc.sem_from}学期` : `第${pc.sem_from}-${pc.sem_to}学期`
}
/* 学期号 → 年级表述（1=大一上 … 8=大四下），超出范围返回 null */
function semCN(n) {
  if (!(n >= 1 && n <= 8)) return null
  return ['大一', '大二', '大三', '大四'][Math.floor((n - 1) / 2)] + (n % 2 === 1 ? '上' : '下')
}
/* 学年学期（2024-2025-1）→ 学期号（按入学年级换算，如 24 级 2024-2025-1 = 第 1 学期）；换算不了原样返回 */
function termCN(term, enrollYear) {
  if (!term || !/^\d{4}-\d{4}-\d$/.test(term)) return null
  const n = termToSem(term, enrollYear)
  return n ? String(n) : term
}
/* 学期编号说明（表格顶部一行注释用） */
const TERM_LEGEND = '学期编号：1 大一上 · 2 大一下 · 3 大二上 · 4 大二下 · 5 大三上 · 6 大三下 · 7 大四上 · 8 大四下'
function progressBar(pct, w) {
  return h('div', { class: 'pbar', style: w ? `width:${w}px` : '' },
    h('div', { class: 'pbar-in', style: `width:${Math.min(100, Math.max(0, pct))}%` }))
}

/* ============================================================
 * 可视化：纯 SVG / CSS 手绘图表（无外部依赖，随主题配色）
 * 只服务于学生自己看得懂：我修到哪了 / 每学期怎么分布 / 成绩走势
 * ============================================================ */
const VIZ_C = {
  green: '#7b915c', greenDk: '#5d7143', yellow: '#f2d489', pink: '#f2b3c0',
  red: '#b8504a', redLt: '#f3c1bc', ink: '#4a4535', soft: '#6d6a52',
  track: '#e9e4cf', cream: '#fdfaf0', leaf: '#93b073', orange: '#e0a11b',
}

/* ============================================================
 * v3 拼图视觉引擎：配色＝类目，形态＝状态
 * ------------------------------------------------------------
 * 一块碎片 = 一门课。类目决定颜色（六大类各一色，子类继承所属大类），
 * 修读状态决定填充与描边虚实：
 *   已修   实色实线 · 在修 提亮浅色实线 · 待补 灰虚线 · 未通过 陶橘虚线
 * 碎片之间用圆头卡扣咬合，相邻边互为凸/凹，拼起来严丝合缝。
 * ============================================================ */
const PUZ_TOP = {
  POL: '#f2b3c0',    /* 思想政治理论课程 · 柔粉 */
  PUB: '#7b915c',    /* 公共基础课程 · 主绿 */
  PEAL: '#f2d489',   /* 体美劳育课程 · 暖黄 */
  GE: '#93b073',     /* 通识课程 · 嫩叶绿 */
  MAJOR: '#5d7143',  /* 学科专业类课程 · 深绿 */
  PRAC: '#c39a72',   /* 实践教学环节 · 陶土 */
}
const PUZ_TOP_ORDER = ['POL', 'PUB', 'PEAL', 'GE', 'MAJOR', 'PRAC']
function puzEsc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
/* 顶层大类 code（子类向上找到根） */
function puzTopCode(plan, code) {
  let cur = plan.cats.find(c => c.code === code), guard = 0
  while (cur && cur.parent_code && guard++ < 10) cur = plan.cats.find(c => c.code === cur.parent_code)
  return cur ? cur.code : code
}
function puzColor(plan, code) { return PUZ_TOP[puzTopCode(plan, code)] || VIZ_C.leaf }
/* 提亮（向白色混合）：在修色 = 类目色提亮约 58%，与设计稿同量级 */
function puzLight(hex, a = 0.58) {
  const n = parseInt(String(hex).slice(1), 16)
  const mix = (v) => Math.round(v + (255 - v) * a)
  return '#' + [mix((n >> 16) & 255), mix((n >> 8) & 255), mix(n & 255)]
    .map(v => v.toString(16).padStart(2, '0')).join('')
}
/* 深色块内文字用奶油白，浅色块用深棕，保证对比度 */
function puzDark(hex) {
  const n = parseInt(String(hex).slice(1), 16)
  return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) < 150
}
/* 状态 → 填充/描边/虚线/文字色 */
function puzStyle(k, catHex) {
  switch (k) {
    case 'pass': return { fill: catHex, stroke: VIZ_C.ink, dash: '', text: puzDark(catHex) ? '#fdfaf0' : '#2f2f22' }
    case 'doing': return { fill: puzLight(catHex), stroke: catHex, dash: '', text: '#33301f' }
    case 'fail': return { fill: '#f7e3d8', stroke: '#b5705a', dash: '9 6', text: '#96513c' }
    case 'todo': return { fill: '#f4efdd', stroke: '#c9c4a9', dash: '9 7', text: '#8d8a72' }
    default: return { fill: '#f4efdd', stroke: '#c9c4a9', dash: '9 7', text: '#8d8a72' }  /* opt 可选 */
  }
}
/* 单块拼图路径：四边各 flat（直）/ out（凸）/ in（凹）；t 为卡扣半径 */
function puzTile(x, y, w, h, e, t) {
  const x2 = x + w, y2 = y + h, xm = x + w / 2, ym = y + h / 2
  let d = `M ${x} ${y}`
  /* 顶边卡扣：out 向上凸出（sweep 1 过圆顶），in 向内凹进本块（sweep 0）。
     方向曾画反——in 的圆弧鼓到上边去，后画的那块会把上一行碎片的学分文字盖住 */
  if (e.t === 'flat') d += ` L ${x2} ${y}`
  else d += ` L ${xm - t} ${y} A ${t} ${t} 0 0 ${e.t === 'out' ? 1 : 0} ${xm + t} ${y} L ${x2} ${y}`
  if (e.r === 'flat') d += ` L ${x2} ${y2}`
  else d += ` L ${x2} ${ym - t} A ${t} ${t} 0 0 ${e.r === 'out' ? 1 : 0} ${x2} ${ym + t} L ${x2} ${y2}`
  if (e.b === 'flat') d += ` L ${x} ${y2}`
  else d += ` L ${xm + t} ${y2} A ${t} ${t} 0 0 ${e.b === 'out' ? 1 : 0} ${xm - t} ${y2} L ${x} ${y2}`
  if (e.l === 'flat') d += ` L ${x} ${y}`
  else d += ` L ${x} ${ym + t} A ${t} ${t} 0 0 ${e.l === 'out' ? 1 : 0} ${x} ${ym - t} L ${x} ${y}`
  return d + ' Z'
}
/* 课名折行：中文按 1、西文按 0.56 计宽；两行时取宽度差最小的断点，
   实在装不下截断加省略号（设计稿同款处理，如「数据库理 / 论与技术」） */
function puzWrap(text, maxUnits, maxLines = 2) {
  let s = String(text || '').trim()
  const stripped = s.replace(/[（(].*?[)）]/g, '').trim()
  if (stripped) s = stripped
  const unit = (ch) => (/[\u4e00-\u9fa5\u3000-\u303f]/.test(ch) ? 1 : 0.56)
  const units = (str) => [...str].reduce((a, ch) => a + unit(ch), 0)
  const chars = [...s]
  if (units(s) <= maxUnits) return [s]
  const truncate1 = () => {
    let out = ''
    for (const ch of chars) { if (units(out + ch) > maxUnits - 1) break; out += ch }
    return [out + '…']
  }
  if (maxLines < 2) return truncate1()
  const total = units(s)
  if (total > maxUnits * 2) {
    /* 装不下两整行：第一行放满，第二行放剩余能放的 + 省略号 */
    let l1 = '', i = 0
    for (; i < chars.length; i++) { if (units(l1 + chars[i]) > maxUnits) break; l1 += chars[i] }
    let l2 = ''
    for (; i < chars.length; i++) { if (units(l2 + chars[i] + '…') > maxUnits) break; l2 += chars[i] }
    if (!l2) return truncate1()
    return [l1, l2 + '…']
  }
  /* 均衡断行：在两行宽度差最小的位置断开 */
  let best = 0, bestDiff = Infinity
  for (let i = 1; i < chars.length; i++) {
    const u1 = units(chars.slice(0, i).join(''))
    if (u1 > maxUnits) break
    const diff = Math.abs(u1 - (total - u1))
    if (diff < bestDiff) { bestDiff = diff; best = i }
  }
  if (!best) return truncate1()
  return [chars.slice(0, best).join(''), chars.slice(best).join('')]
}
/* 拼图网格：items = [{name, credit, k, tip}]，返回 SVG 字符串
   相邻接缝互为凸/凹，边缘保持平直 —— 所以 pad 要留出卡扣的余量 */
function puzSVG(items, opt = {}) {
  const cols = opt.cols || 3
  const cw = opt.cellW || 96, ch = opt.cellH || 76
  const list = items || []
  if (!list.length) return ''
  const rows = Math.ceil(list.length / cols)
  const t = Math.round(Math.min(cw, ch) * 0.185)
  const pad = t + 5
  const W = cols * cw + pad * 2, H = rows * ch + pad * 2
  const vSeam = (c) => (c % 2 === 0 ? 'out' : 'in')
  const hSeam = (r) => (r % 2 === 0 ? 'out' : 'in')
  let s = `<svg class="grid-puzzle" viewBox="0 0 ${W} ${H}" role="img" aria-label="${puzEsc(opt.aria || '学分拼图')}">`
  list.forEach((it, i) => {
    const r = Math.floor(i / cols), c = i % cols
    const x = pad + c * cw, y = pad + r * ch
    const e = {
      t: r === 0 ? 'flat' : (hSeam(r - 1) === 'out' ? 'in' : 'out'),
      b: r === rows - 1 ? 'flat' : hSeam(r),
      l: c === 0 ? 'flat' : (vSeam(c - 1) === 'out' ? 'in' : 'out'),
      r: c === cols - 1 ? 'flat' : vSeam(c),
    }
    const st = puzStyle(it.k, it.hex || VIZ_C.leaf)
    const cls = 'frag' + (it.k === 'todo' || it.k === 'opt' ? ' is-todo' : '') + (it.k === 'doing' ? ' is-doing' : '')
    /* 入场方向：按碎片在网格里的方位给一点位移，拼起来的动势更自然 */
    const dx = (c - (cols - 1) / 2) * 20, dy = (r - (rows - 1) / 2) * 23
    const lines = puzWrap(it.name, cw / 13.2, 2)
    /* 文字块（课名 + 学分）随块高自适应并垂直居中：行高、块高都按 ch 缩放，
       小碎片（cellH 64）两行课名也不会和学分挤在一起，且上下都避开卡扣内凹区 */
    const lh = Math.min(13.6, ch * 0.2)
    const blockH = lines.length * lh + 14
    const blockTop = y + (ch - blockH) / 2
    s += `<g class="${cls}" style="--i:${i};--dx:${dx}px;--dy:${dy}px">`
    s += `<title>${puzEsc(it.tip || `${it.name} · ${it.credit} 学分`)}</title>`
    s += `<path d="${puzTile(x, y, cw, ch, e, t)}" fill="${st.fill}" stroke="${st.stroke}" stroke-width="${st.dash ? 3 : 3.4}"${st.dash ? ` stroke-dasharray="${st.dash}"` : ''} stroke-linejoin="round"/>`
    lines.forEach((ln, li) => {
      s += `<text x="${x + cw / 2}" y="${blockTop + li * lh + 9}" class="f-name" fill="${st.text}">${puzEsc(ln)}</text>`
    })
    const crTxt = `${Number(it.credit)} 学分`
    s += `<text x="${x + cw / 2}" y="${blockTop + lines.length * lh + 11}" class="f-cr" fill="${st.text}" opacity=".85">${puzEsc(crTxt)}</text>`
    s += '</g>'
  })
  return s + '</svg>'
}
/* 把拼图 SVG 装进容器（带图例/说明的排版由调用方决定） */
function puzBlock(items, opt = {}) {
  const svg = puzSVG(items, opt)
  const box = h('div', { class: 'puzzle-block' })
  if (opt.complete) {
    const wrap = h('div', { class: 'complete-wrap' })
    wrap.innerHTML = svg
    box.append(wrap)
  } else {
    box.innerHTML = svg
  }
  if (opt.cap) box.append(h('div', { class: 'puzzle-cap' }, opt.cap))
  return box
}
/* 拼图状态图例（类目色随传入色变化） */
function puzLegend(catHex) {
  return h('div', { class: 'puz-legend' },
    h('span', { class: 'lg' }, h('i', { class: 'dot', style: `background:${catHex}` }), '已修满'),
    h('span', { class: 'lg' }, h('i', { class: 'dot', style: `background:${puzLight(catHex)};border-color:${catHex}` }), '在修'),
    h('span', { class: 'lg' }, h('i', { class: 'dot todo' }), '待补缺口'),
    h('span', { class: 'lg' }, h('i', { class: 'dot fail' }), '未通过'),
  )
}
/* 类目配色图例：六大类各一色（拼图「颜色＝类目」这一层的对照表） */
function puzCatLegend(plan, codes) {
  const list = codes || PUZ_TOP_ORDER
  return h('div', { class: 'puz-legend cat' },
    ...list.map(code => {
      const c = plan.cats.find(x => x.code === code)
      if (!c) return null
      return h('span', { class: 'lg' }, h('i', { class: 'dot', style: `background:${PUZ_TOP[code] || VIZ_C.leaf}` }), c.name)
    }))
}
/* 学期拼图链：8 个学期首尾相扣；done 已读 / now 当前 / wait 未来 */
function semChain(terms, curSem) {
  return h('div', { class: 'chain' },
    ...terms.map((t, i) => h('div', {
      class: 'sem ' + (t < curSem ? 'done' : t === curSem ? 'now' : 'wait'),
      style: `--i:${i + 1}`,
      title: t < curSem ? `第 ${t} 学期（已读完）` : t === curSem ? `第 ${t} 学期（当前）` : `第 ${t} 学期（未开始）`,
    }, h('span', { class: 'tab' }), h('span', { class: 'body' }, `${t} ${semCN(t)}`))))
}

/* 侧栏导航图标：一块拼图碎片，颜色对应页面所讲的主题大类 */
const NAV_HEX = {
  myProgress: PUZ_TOP.GE,
  myAdvice: PUZ_TOP.PEAL,
  myTimeline: PUZ_TOP.PUB,
  myPlan: PUZ_TOP.MAJOR,
  myPlanRead: PUZ_TOP.PRAC,
  myScores: PUZ_TOP.POL,
  adminRoster: '#9b8ec4',
  adminUsers: '#7fa8d9',
}
function puzMini(hex, size = 20, dash = false) {
  return `<svg viewBox="0 0 34 34" class="mini" style="--sz:${size}px" aria-hidden="true">` +
    `<path d="M 3 3 L 14 3 A 5.5 5.5 0 0 1 25 3 L 31 3 L 31 31 L 3 31 Z" fill="${hex}" stroke="${dash ? '#c9c4a9' : VIZ_C.ink}" stroke-width="2.5" stroke-linejoin="round"${dash ? ' stroke-dasharray="4 3"' : ''}/></svg>`
}
/* 小块拼图徽标（行内、表格里用），k = pass/doing/todo/fail */
function puzChip(catHex, k, size = 15) {
  const st = puzStyle(k, catHex)
  return `<svg viewBox="0 0 34 34" class="mini chip" style="--sz:${size}px" aria-hidden="true">` +
    `<path d="M 3 3 L 14 3 A 5.5 5.5 0 0 1 25 3 L 31 3 L 31 31 L 3 31 Z" fill="${st.fill}" stroke="${st.stroke}" stroke-width="${st.dash ? 3 : 2.8}" stroke-linejoin="round"${st.dash ? ` stroke-dasharray="${st.dash}"` : ''}/></svg>`
}

/* 空状态：一块灰虚线拼图 + 引导语（v3） */
function emptyBox(title, tip, actions = []) {
  const ic = h('span', { class: 'emptybox-ic' })
  ic.innerHTML = puzMini('#f4efdd', 44, true)
  return h('div', { class: 'emptybox' }, ic,
    h('div', {},
      h('b', {}, title),
      h('div', { class: 'tip' }, tip),
      actions.length ? h('div', { class: 'toolbar', style: 'margin-top:10px' }, ...actions) : null))
}

function svgHost(inner, cls) {
  const d = h('div', { class: 'viz' + (cls ? ' ' + cls : '') })
  d.innerHTML = inner
  return d
}
function vizLegend(items) {
  return h('div', { class: 'viz-legend' },
    ...items.map(it => h('span', { class: 'lg' }, h('i', { class: 'sw', style: `background:${it.color}` }), it.text)))
}

/* 环形进度：parts = [{value, color}]，total 为分母 */
function vizRing({ size = 196, stroke = 24, parts = [], total, centerNum = '', centerSub = '', centerTop = '' }) {
  const r = (size - stroke) / 2, cx = size / 2, cy = size / 2, C2 = 2 * Math.PI * r
  const tot = total || parts.reduce((s, p) => s + p.value, 0) || 1
  let acc = 0, arcs = ''
  for (const p of parts) {
    if (!(p.value > 0)) continue
    const frac = Math.min(1, p.value / tot)
    const len = frac * C2
    arcs += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${p.color}" stroke-width="${stroke}"` +
      ` stroke-dasharray="${len.toFixed(2)} ${(C2 - len).toFixed(2)}"` +
      ` stroke-dashoffset="${(-acc * C2).toFixed(2)}"` +
      ` transform="rotate(-90 ${cx} ${cy})"/>`
    acc += frac
  }
  const svg = `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">` +
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${VIZ_C.track}" stroke-width="${stroke}"/>${arcs}</svg>`
  const box = h('div', { class: 'ring-wrap' }, svgHost(svg))
  box.append(h('div', { class: 'ring-center' },
    centerTop ? h('div', { class: 'ring-top' }, centerTop) : null,
    h('div', { class: 'ring-num' }, centerNum),
    h('div', { class: 'ring-sub' }, centerSub),
  ))
  return box
}

/* 分类完成度横条：每个培养方案大类一条，已获 / 在修 / 缺口一目了然 */
function vizCatBars(plan, agg) {
  const wrap = h('div', { class: 'catbars' })
  for (const cat of agg.roots) {
    const info = agg.catProg[cat.code]
    if (!info || !info.req) continue
    const req = Number(info.req), got = info.got, prog = info.prog || 0, rest = info.rest
    const gp = Math.min(100, got / req * 100)
    const pp = Math.min(100 - gp, prog / req * 100)
    wrap.append(h('div', { class: 'cb-row' },
      h('div', { class: 'cb-name', title: cat.name }, cat.name),
      h('div', { class: 'cb-track' },
        h('div', { class: 'cb-got', style: `width:${gp}%` }),
        h('div', { class: 'cb-prog', style: `width:${pp}%;left:${gp}%` }),
      ),
      h('div', { class: 'cb-val' }, `${n1(got)}/${req}`),
      rest > 0
        ? h('span', { class: 'tag red' }, `差 ${n1(rest)}`)
        : (prog >= rest && rest === 0 && gp < 100
          ? h('span', { class: 'tag blue' }, `在修 ${n1(prog)}`)
          : h('span', { class: 'tag green' }, '达标')),
    ))
  }
  return wrap
}

/* 各学期学分堆叠柱状图：已修 / 在修 / 未完成 / 可选，虚线为计划学分 */
function vizTermStack(rows, { height = 250 } = {}) {
  const W = 780, H = height, padL = 40, padR = 14, padT = 24, padB = 42
  const plotW = W - padL - padR, plotH = H - padT - padB
  const maxV = Math.max(10, ...rows.map(d => Math.max(d.planned, d.total)))
  const step = maxV > 30 ? 10 : 5
  const top = Math.ceil(maxV / step) * step
  const y = v => padT + plotH - (v / top) * plotH
  const colW = plotW / rows.length
  const bw = Math.min(52, colW * 0.52)
  let g = ''
  /* 网格 + Y 轴刻度 */
  for (let v = 0; v <= top; v += step) {
    g += `<line x1="${padL}" y1="${y(v).toFixed(1)}" x2="${W - padR}" y2="${y(v).toFixed(1)}" stroke="${VIZ_C.track}" stroke-width="1"/>`
    g += `<text x="${padL - 7}" y="${(y(v) + 3.5).toFixed(1)}" text-anchor="end" font-size="10" fill="${VIZ_C.soft}">${v}</text>`
  }
  rows.forEach((d, i) => {
    const cxx = padL + colW * i + colW / 2
    const x0 = cxx - bw / 2
    const segs = [
      { v: d.pass, c: VIZ_C.green },
      { v: d.doing, c: VIZ_C.yellow },
      { v: d.rest, c: VIZ_C.redLt },
      { v: d.opt, c: VIZ_C.track },
    ]
    if (d.total <= 0) {
      g += `<rect x="${x0}" y="${padT}" width="${bw}" height="${plotH}" rx="7" fill="none" stroke="${VIZ_C.track}" stroke-width="2" stroke-dasharray="4 4"/>`
    } else {
      let base = 0
      for (const sg of segs) {
        if (!(sg.v > 0)) continue
        const yTop = y(base + sg.v), hh = y(base) - yTop
        g += `<rect x="${x0}" y="${yTop.toFixed(1)}" width="${bw}" height="${Math.max(1, hh).toFixed(1)}" fill="${sg.c}"/>`
        base += sg.v
      }
      g += `<rect x="${x0}" y="${y(d.total).toFixed(1)}" width="${bw}" height="${(y(0) - y(d.total)).toFixed(1)}" rx="7" fill="none" stroke="${VIZ_C.ink}" stroke-width="2"/>`
    }
    /* 计划学分标记线 */
    if (d.planned > 0) {
      const yp = y(d.planned)
      g += `<line x1="${x0 - 5}" y1="${yp.toFixed(1)}" x2="${x0 + bw + 5}" y2="${yp.toFixed(1)}" stroke="${VIZ_C.ink}" stroke-width="2" stroke-dasharray="5 4"/>`
    }
    const label = d.total > 0 ? n1(d.total) : '—'
    g += `<text x="${cxx}" y="${(y(d.total || 0) - 7).toFixed(1)}" text-anchor="middle" font-size="11" font-weight="800" fill="${VIZ_C.ink}">${label}</text>`
    g += `<text x="${cxx}" y="${padT + plotH + 17}" text-anchor="middle" font-size="11" font-weight="700" fill="${d.now ? VIZ_C.greenDk : VIZ_C.soft}">第${d.t}学期</text>`
    g += `<text x="${cxx}" y="${padT + plotH + 31}" text-anchor="middle" font-size="10" fill="${VIZ_C.soft}">计划 ${d.planned}</text>`
    if (d.now) g += `<rect x="${padL + colW * i + 2}" y="${padT - 12}" width="${colW - 4}" height="${plotH + 12}" rx="9" fill="${VIZ_C.yellow}" opacity="0.22"/>`
  })
  return svgHost(`<svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet">${g}</svg>`, 'stack')
}

/* 各学期成绩走势折线图：主数字平均分，点下标平均绩点，虚线为及格线 */
function vizScoreLine(pts, { height = 230 } = {}) {
  const W = 780, H = height, padL = 40, padR = 36, padT = 26, padB = 46
  const plotW = W - padL - padR, plotH = H - padT - padB
  /* Y 轴自适应：数据都偏高时缩小下限，避免曲线挤成一团 */
  const avgMin = Math.min(...pts.map(p => p.avg))
  const lo = Math.max(60, Math.floor((avgMin - 6) / 5) * 5)
  const hi = 100
  const step = hi - lo > 30 ? 10 : 5
  const y = v => padT + plotH - ((Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo)) * plotH
  const x = i => padL + (pts.length === 1 ? plotW / 2 : (plotW * i) / (pts.length - 1))
  let g = ''
  for (let v = lo; v <= hi; v += step) {
    const isPass = v === 60
    g += `<line x1="${padL}" y1="${y(v).toFixed(1)}" x2="${W - padR}" y2="${y(v).toFixed(1)}" stroke="${isPass ? VIZ_C.redLt : VIZ_C.track}" stroke-width="${isPass ? 2 : 1}" ${isPass ? 'stroke-dasharray="6 5"' : ''}/>`
    g += `<text x="${padL - 7}" y="${(y(v) + 3.5).toFixed(1)}" text-anchor="end" font-size="10" fill="${VIZ_C.soft}">${v}</text>`
  }
  if (lo <= 60) g += `<text x="${W - padR}" y="${(y(60) - 5).toFixed(1)}" text-anchor="end" font-size="10" fill="${VIZ_C.red}">及格 60</text>`
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.avg).toFixed(1)}`).join(' ')
  const area = `${line} L${x(pts.length - 1).toFixed(1)},${(padT + plotH).toFixed(1)} L${x(0).toFixed(1)},${(padT + plotH).toFixed(1)} Z`
  g += `<path d="${area}" fill="${VIZ_C.leaf}" opacity="0.18"/>`
  g += `<path d="${line}" fill="none" stroke="${VIZ_C.green}" stroke-width="3.5" stroke-linejoin="round" stroke-linecap="round"/>`
  pts.forEach((p, i) => {
    g += `<circle cx="${x(i).toFixed(1)}" cy="${y(p.avg).toFixed(1)}" r="6" fill="${VIZ_C.cream}" stroke="${VIZ_C.ink}" stroke-width="2.5"/>`
    g += `<text x="${x(i).toFixed(1)}" y="${(y(p.avg) - 12).toFixed(1)}" text-anchor="middle" font-size="11" font-weight="800" fill="${VIZ_C.ink}">${n1(p.avg)}</text>`
    g += `<text x="${x(i).toFixed(1)}" y="${padT + plotH + 18}" text-anchor="middle" font-size="10.5" font-weight="700" fill="${VIZ_C.soft}">${p.label}</text>`
    const gpTxt = p.gp !== null && p.gp !== undefined ? `绩点 ${Number(p.gp).toFixed(2)}` : '—'
    g += `<text x="${x(i).toFixed(1)}" y="${padT + plotH + 32}" text-anchor="middle" font-size="9.5" fill="${VIZ_C.soft}">${gpTxt}</text>`
  })
  return svgHost(`<svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet">${g}</svg>`, 'line')
}

/* 学业风险评估 */
function assessRisk(plan, agg, curSem) {
  const tc = plan.term_credits || []
  const y = plan.years || 4
  const planned = tc.slice(0, Math.min(curSem, tc.length)).reduce((a, b) => a + b, 0)
  const gap = Math.max(0, planned - agg.totalGot)
  const remainTerms = Math.max(0, y * 2 - curSem) + 1
  const remainPlan = tc.slice(curSem - 1).reduce((a, b) => a + b, 0)
  const ceiling = agg.totalGot + agg.totalProg + remainPlan
  let level, title, text
  if (gap <= 6) {
    level = 'ok'; title = '进度正常'
    text = `按指导性修读计划，第 ${curSem} 学期结束应累计修满约 ${planned} 学分，你已获得 ${n1(agg.totalGot)} 学分，进度跟得上。`
  } else if (gap <= 20) {
    level = 'warn'; title = '进度偏慢 ' + n1(gap) + ' 学分'
    text = `按指导性修读计划，第 ${curSem} 学期结束应累计修满约 ${planned} 学分，你目前获得 ${n1(agg.totalGot)} 学分，落后约 ${n1(gap)} 学分。还有 ${remainTerms} 个学期、计划可修 ${n1(remainPlan)} 学分，来得及追平。`
  } else {
    level = 'bad'; title = '进度严重落后 ' + n1(gap) + ' 学分'
    text = `按指导性修读计划，第 ${curSem} 学期结束应累计修满约 ${planned} 学分，你目前只有 ${n1(agg.totalGot)} 学分，落后约 ${n1(gap)} 学分。剩余 ${remainTerms} 个学期计划可修 ${n1(remainPlan)} 学分，必须尽快把错过的必修课补上。`
  }
  const finish = ceiling >= agg.totalReq
  return {
    level, title, text, planned, gap, remainTerms, remainPlan, ceiling, finish,
    need: Math.max(0, agg.totalReq - agg.totalGot - agg.totalProg),
  }
}

/* ============================================================
 * 公共数据装载：方案 + 我的成绩 + 当前学期 + 聚合结果
 * ============================================================ */
function guessEnrollYear(sid) {
  const m = /^(\d{4})/.exec(String(sid || ''))
  return m ? m[1] : String(new Date().getFullYear() - 2)
}
async function baseData() {
  let me = null
  try {
    const list = await dbSelect('students')
    me = list.find(s => s.student_id === state.profile?.student_id) || null
  } catch (e) { /* 无权读名册时忽略 */ }
  state.planMajor = me?.major_name || ''   // 供后续 loadPlan() 复用同一专业的方案
  const plan = await loadPlan(me?.major_name)
  const ctx = await loadContext()
  const mine = await loadMyScores(ctx)
  const enrollYear = me?.enroll_year ? String(me.enroll_year) : guessEnrollYear(state.profile?.student_id)
  const t0 = termToSem(currentTerm(), enrollYear)
  const curSem = t0 && t0 > 0 && t0 <= 8 ? t0 : 5
  const agg = mine.length ? analyzePlan(plan, mine) : null
  return { plan, ctx, mine, me, enrollYear, curSem, agg }
}

/* ============================================================
 * 页面：我的进度
 * ============================================================ */
const PAGES = {}

PAGES.myProgress = async (main) => {
  const base = await baseData()
  const { plan, mine, me, curSem } = base
  const term = currentTerm()

  main.append(h('div', { class: 'page-title' }, '我的进度'))
  main.append(h('p', { class: 'page-sub' },
    `${me?.name || state.profile?.real_name || ''} · ${me?.class_name || '信管专业'} · ${plan.major} · ${plan.version} 版培养方案 · 当前 ${term}（第 ${curSem} 学期） · 毕业最低 ${plan.total_credits} 学分`))

  if (!mine.length) {
    const phIc = h('span', { class: 'hero-ic' })
    phIc.innerHTML = puzMini('#f4efdd', 72, true)
    main.append(h('div', { class: 'card hero-card' },
      phIc,
      h('h3', {}, '先导入你的成绩，才能算出进度'),
      h('p', { class: 'muted' }, '这个站点不依赖老师录成绩 —— 你自己从学校教务系统导出选课/成绩单，按模板整理成 Excel（.xlsx）上传，系统会自动把每门课对应到培养方案里，算出你还差什么。'),
      h('div', { class: 'toolbar', style: 'margin:14px 0 0' },
        h('button', { class: 'btn primary', onclick: () => goto('myScores') }, '去导入我的成绩'),
        h('button', { class: 'btn', onclick: () => goto('myPlanRead') }, '先看看培养方案要修什么'),
      )))
    return
  }

  /* v3 学期拼图链：八个学期首尾相扣，一眼看完四年节奏 */
  main.append(h('div', { class: 'card chain-card' },
    h('h3', {}, '四年节奏'),
    semChain([1, 2, 3, 4, 5, 6, 7, 8], curSem),
    h('div', { class: 'chain-foot' }, `当前第 ${curSem} 学期（${term}）· 学期编号 1 大一上 … 8 大四下`)))

  const agg = base.agg
  const risk = assessRisk(plan, agg, curSem)

  /* 风险横幅 */
  main.append(h('div', { class: 'risk-banner ' + risk.level },
    h('div', { class: 'risk-dot' }),
    h('div', {},
      h('div', { class: 'risk-title' }, risk.title),
      h('div', { class: 'risk-text' }, risk.text),
      h('div', { class: 'risk-foot' },
        `按当前记录推算，毕业时最乐观约 ${n1(risk.ceiling)} 学分（要求 ${agg.totalReq}）`,
        risk.finish ? h('span', { class: 'tag green' }, '可达毕业线') : h('span', { class: 'tag red' }, '存在毕业风险'),
      ),
    )))

  /* 总进度：环形仪表 + 明细 */
  const gotPct = agg.totalGot / agg.totalReq * 100
  main.append(h('div', { class: 'card' },
    h('h3', {}, '毕业学分总进度'),
    h('div', { class: 'ring-panel' },
      vizRing({
        size: 196, stroke: 24, total: agg.totalReq,
        parts: [
          { value: agg.totalGot, color: VIZ_C.green },
          { value: agg.totalProg, color: VIZ_C.yellow },
        ],
        centerTop: '已完成',
        centerNum: gotPct.toFixed(1) + '%',
        centerSub: `${n1(agg.totalGot)} / ${agg.totalReq} 学分`,
      }),
      h('div', { class: 'ring-side' },
        h('div', { class: 'rs-row' }, h('b', {}, n1(agg.totalGot)), h('span', {}, '已获得学分')),
        h('div', { class: 'rs-row' }, h('b', {}, n1(agg.totalProg)), h('span', {}, '本学期修读中')),
        h('div', { class: 'rs-row warn' }, h('b', {}, n1(agg.totalRest)), h('span', {}, '距毕业还差')),
        h('div', { class: 'rs-note' }, `按当前记录推算，毕业时最乐观约 ${n1(risk.ceiling)} 学分（要求 ${agg.totalReq}）`),
      ),
    ),
    vizLegend([
      { color: VIZ_C.green, text: `已获得 ${n1(agg.totalGot)} 学分` },
      { color: VIZ_C.yellow, text: `本学期修读中 ${n1(agg.totalProg)} 学分` },
      { color: VIZ_C.track, text: `还差 ${n1(agg.totalRest)} 学分` },
    ])))

  /* 各模块完成度（一眼看出短板在哪） */
  main.append(h('div', { class: 'card' },
    h('h3', {}, '各模块学分完成度'),
    h('p', { class: 'muted', style: 'margin-bottom:12px' }, '绿条是已获得、黄条是本学期在修、虚线右侧的空白就是缺口。'),
    vizCatBars(plan, agg)))

  /* 统计卡可点：已获得学分 → 我的课程；本学期修读中 → 定位到在修记录；距毕业还差 → 查漏补缺
     （在修 = 状态「在修」；已完成无成绩的课 —— 认定课 / 无绩点模式的已结业课 —— 不算在修） */
  const doingN = mine.filter(s => s.status === '在修').length
  main.append(h('div', { class: 'stat-grid' },
    h('div', { class: 'stat' }, h('b', {}, agg.totalReq), h('span', {}, '毕业要求学分')),
    h('div', { class: 'stat link', title: '点击查看成绩明细', onclick: () => goto('myScores') },
      h('b', {}, n1(agg.totalGot)), h('span', {}, '已获得学分')),
    doingN ? h('div', { class: 'stat link', title: '点击查看在修课程', onclick: () => goto('myScores', 'doing') },
             h('b', {}, n1(agg.totalProg)), h('span', {}, '本学期修读中'))
           : h('div', { class: 'stat' }, h('b', {}, n1(agg.totalProg)), h('span', {}, '本学期修读中')),
    h('div', { class: 'stat warn link', title: '点击查看逐级缺口明细', onclick: () => goto('myPlan') },
      h('b', {}, n1(agg.totalRest)), h('span', {}, '距毕业还差')),
    h('div', { class: 'stat' }, h('b', {}, risk.remainTerms), h('span', {}, '剩余学期（含本学期）')),
  ))

  /* 本学期修读中（v3：一门课＝一块碎片，颜色＝类目、形态＝在修） */
  const doing = mine.filter(s => s.status === '在修')
  const doingCard = h('div', { class: 'card' }, h('h3', {}, `本学期修读中（${doing.length} 门）`))
  if (doing.length) {
    const doingPc = (s) => plan.byCode[s.course?.plan_code || s.course?.course_id] || matchPlanCourse(plan, s.course?.course_name, s.course?.credit)
    const items = doing.map(s => {
      const pc = doingPc(s)
      return {
        name: s.course?.course_name || '—',
        credit: Number(s.course?.credit ?? 0),
        k: 'doing',
        hex: pc ? puzColor(plan, pc.category_code) : VIZ_C.leaf,
        tip: `${s.course?.course_name || '—'} · ${Number(s.course?.credit ?? 0)} 学分（在修）\n归属：${pc ? catPath(plan, pc.category_code) : '方案外'}`,
      }
    })
    doingCard.append(h('p', { class: 'muted', style: 'margin-bottom:10px' }, '每块碎片是一门课：颜色＝它属于哪一类，浅色＝本学期在修。悬停可看学分与归属。'))
    /* 碎片别放太大：6 列 + 限制整图最宽 660px，块面尺寸接近自然大小 */
    const db = puzBlock(items, { cols: 6, cellW: 96, cellH: 64, aria: '本学期修读中的课程拼图' })
    db.style.maxWidth = '660px'
    doingCard.append(db)
    doingCard.append(puzCatLegend(plan))
    const tbl = h('table', { class: 'tbl' })
    tbl.append(h('tr', {}, ...['课程名称', '学分', '学分归属'].map(x => h('th', {}, x))))
    for (const s of doing) {
      const pc = doingPc(s)
      tbl.append(h('tr', {},
        h('td', {}, s.course?.course_name || '—'),
        h('td', {}, s.course?.credit ?? '—'),
        h('td', {}, pc ? h('span', { class: 'muted' }, catPath(plan, pc.category_code)) : h('span', { class: 'tag orange' }, '方案外')),
      ))
    }
    doingCard.append(tbl)
  } else {
    doingCard.append(h('p', { class: 'empty' }, '还没有在修记录。学期初选课后，把新学期的课导入进来即可。'))
  }
  main.append(doingCard)

  /* 待补清单 */
  const gaps = agg.reqRows.filter(c => agg.catProg[c.code]?.rest > 0)
  const gapCard = h('div', { class: 'card' }, h('h3', {}, gaps.length ? `最该补的 ${Math.min(5, gaps.length)} 项` : '待补清单'))
  if (gaps.length) {
    gaps.sort((a, b) => agg.catProg[b.code].rest - agg.catProg[a.code].rest)
    const ul = h('ul', { class: 'gap-list' })
    for (const c of gaps.slice(0, 5)) {
      const info = agg.catProg[c.code]
      const sub = agg.subtreeOf(c.code)
      const pend = plan.courses.filter(p => sub.includes(p.category_code) && !agg.isElective(p) && ['todo', 'fail'].includes(agg.statusOf(p).k))
      const subReqs = agg.subReqNames(c)
      ul.append(h('li', {},
        h('b', {}, catPath(plan, c.code)),
        h('span', {}, `还差 ${n1(info.rest)} 学分（已获 ${n1(info.got)} / 要求 ${Number(info.req)}）`),
        pend.length ? h('span', { class: 'gap-more' }, `需补 ${pend.length} 门课`) : h('span', { class: 'gap-more' }, '可在该类目里任选补足'),
        subReqs.length ? h('span', { class: 'gap-sub' }, `（本级要求，另需 ${subReqs.join('、')}）`) : null,
      ))
    }
    gapCard.append(ul)
  } else {
    gapCard.append(h('p', { class: 'empty' }, '🎉 培养方案内的学分要求已经全部满足'))
  }
  gapCard.append(h('div', { class: 'toolbar', style: 'margin:12px 0 0' },
    h('button', { class: 'btn sm primary', onclick: () => goto('myAdvice') }, '看本学期该选什么课'),
    h('button', { class: 'btn sm', onclick: () => goto('myPlan') }, '打开逐级对照表'),
  ))
  main.append(gapCard)
}

function catPath(plan, code) {
  const names = []
  let cur = plan.cats.find(c => c.code === code)
  while (cur) { names.unshift(cur.name); cur = cur.parent_code ? plan.cats.find(c => c.code === cur.parent_code) : null }
  return names.join(' · ')
}

/* ============================================================
 * 页面：选课建议
 * ============================================================ */
PAGES.myAdvice = async (main) => {
  const { plan, mine, curSem, agg: computed } = await baseData()
  main.append(h('div', { class: 'page-title' }, '选课建议'))
  const term = currentTerm()

  if (!mine.length) {
    main.append(emptyBox('还没有你的修课记录，暂时给不出建议',
      '先去「我的课程」导入你的成绩单，这里就会按你缺什么给出选课顺序。',
      [h('button', { class: 'btn primary', onclick: () => goto('myScores') }, '去导入成绩')]))
    return
  }

  const agg = computed
  const plannedThis = (plan.term_credits || [])[curSem - 1]
  main.append(h('p', { class: 'page-sub' },
    `当前 ${term}（第 ${curSem} 学期）· 指导性计划建议本学期修读约 ${plannedThis} 学分 · 点开学分归属可看到为什么推荐它`))

  const st = (p) => agg.statusOf(p)

  /* 1. 本学期必须拿下的必修课（已选的在修课也列出并标识，避免重复选） */
  const mustNow = plan.courses.filter(p =>
    p.sem_from <= curSem && p.sem_to >= curSem && ['todo', 'doing'].includes(st(p).k) && !agg.isElective(p))
  /* 2. 已经错过的必修课 */
  const missed = plan.courses.filter(p => p.sem_to < curSem && ['todo', 'fail'].includes(st(p).k) && !agg.isElective(p))
  /* 3. 需要重修（挂过且没通过的） */
  const retake = plan.courses.filter(p => st(p).k === 'fail' && p.sem_to >= curSem)
  /* 4. 可选：还差学分的选修类目里，本学期开的课 */
  const optNow = plan.courses.filter(p =>
    agg.isElective(p) && st(p).k === 'opt' && p.sem_from <= curSem && p.sem_to >= curSem && agg.catDeficit(p.category_code))

  const creditOf = (list) => list.reduce((s, p) => s + Number(p.credits || 0), 0)

  const sec = (title, sub, list, cls, note) => {
    const card = h('div', { class: 'card advice-card ' + cls },
      h('h3', {}, title),
      h('p', { class: 'advice-sub' }, sub))
    if (!list.length) { card.append(h('p', { class: 'empty' }, '无')); return card }
    if (note) card.append(h('p', { class: 'plan-note' }, note))
    const tbl = h('table', { class: 'tbl' })
    tbl.append(h('tr', {}, ...['课程名称', '学分', '建议学期', '性质', '学分归属'].map(x => h('th', {}, x))))
    /* 已选（在修中/已修）排前面，待选的排后面，中间加分隔行，一眼分清哪些已经选了 */
    const chosen = list.filter(p => ['doing', 'pass'].includes(st(p).k))
    const pend = list.filter(p => !['doing', 'pass'].includes(st(p).k))
    const sortP = (a, b) => a.sem_from - b.sem_from || String(a.code).localeCompare(String(b.code))
    const oneRow = (p) => {
      const k = st(p).k
      tbl.append(h('tr', { class: cls === 'bad' && k !== 'doing' && k !== 'pass' ? 'row-gap' : '' },
        h('td', {}, p.name,
          k === 'doing' ? h('span', { class: 'tag blue', style: 'margin-left:6px', title: '你已选了这门课，正在修读' }, '在修中') : null,
          k === 'pass' ? h('span', { class: 'tag green', style: 'margin-left:6px', title: '这门课你已经修过且通过' }, '已修') : null),
        h('td', {}, Number(p.credits)),
        h('td', {}, semLabel(p)),
        h('td', {}, h('span', { class: 'tag ' + (p.nature === '必修' ? 'blue' : 'gray') }, p.nature)),
        h('td', { class: 'muted' }, catPath(plan, p.category_code)),
      ))
    }
    if (chosen.length && pend.length) {
      tbl.append(h('tr', { class: 'adv-group' },
        h('td', { colspan: 5 }, `已选（${chosen.length} 门，含在修/已修，不用再选）`)))
      for (const p of chosen.sort(sortP)) oneRow(p)
      tbl.append(h('tr', { class: 'adv-group sep' },
        h('td', { colspan: 5 }, `待选（${pend.length} 门，从这里挑）`)))
      for (const p of pend.sort(sortP)) oneRow(p)
    } else {
      for (const p of [...chosen, ...pend].sort(sortP)) oneRow(p)
    }
    card.append(tbl)
    return card
  }

  if (mustNow.length) {
    const doingN = mustNow.filter(p => st(p).k === 'doing').length
    main.append(sec('① 本学期就该修',
      `这 ${mustNow.length} 门课的开课窗口正好覆盖第 ${curSem} 学期，合计 ${n1(creditOf(mustNow))} 学分` +
      (doingN ? `，其中 ${doingN} 门你已在修（已标识，不用重复选）` : '，优先选它们。'),
      mustNow, 'ok'))
  } else {
    main.append(h('div', { class: 'card advice-card ok' },
      h('h3', {}, '① 本学期就该修'),
      h('p', { class: 'empty' }, '🎉 按培养方案，本学期没有你还没修的必修课了')))
  }

  if (missed.length) {
    main.append(sec('② 已经错过开课窗口（必须补）', `这 ${missed.length} 门课的开课学期已经过去，你还没修完，合计 ${n1(creditOf(missed))} 学分。只能跟低年级重修或申请开课，越早处理越好。`, missed, 'bad'))
  }
  if (retake.length) {
    main.append(sec('③ 不及格待重修', `下面 ${retake.length} 门课你已经修过但没通过，需要重修。`, retake, 'bad'))
  }
  if (optNow.length) {
    main.append(sec('④ 选修类目还差学分，本学期可挑', `你还有 ${optNow.length} 门选修课在本学期开放，任选修满即可，不必全修。`, optNow, 'ok',
      '提醒：开放性专业选修里，至少要有 4 学分是「交叉类课程」；带「＋」的理论课与实验课必须同时选。'))
  }

  if (!mustNow.length && !missed.length && !retake.length && !optNow.length) {
    main.append(h('div', { class: 'card empty' }, '按当前记录，本学期没有需要特别提醒的课程。'))
  }

  /* 继续探索：与其他页面的数据互通 */
  main.append(h('div', { class: 'toolbar', style: 'margin-top:16px' },
    h('button', { class: 'btn sm primary', onclick: () => goto('myPlan') }, '去查漏补缺看逐级缺口 →'),
    h('button', { class: 'btn sm', onclick: () => goto('myScores', 'doing') }, '查看在修课程 →'),
    retake.length ? h('button', { class: 'btn sm', onclick: () => goto('myScores', 'fail') }, '查看不及格记录 →') : null,
  ))
}

/* ============================================================
 * 页面：学期时间轴
 * ============================================================ */
PAGES.myTimeline = async (main) => {
  const { plan, mine, me, curSem, agg } = await baseData()
  const enrollYear = me?.enroll_year ? String(me.enroll_year) : guessEnrollYear(state.profile?.student_id)
  main.append(h('div', { class: 'page-title' }, '学期时间轴'))

  if (!mine.length) {
    main.append(emptyBox('还没有你的修课记录',
      '导入成绩后，这里会按 8 个学期排好你的每一门课。',
      [h('button', { class: 'btn primary', onclick: () => goto('myScores') }, '去导入成绩')]))
    return
  }
  main.append(h('p', { class: 'page-sub' }, `横轴是 8 个学期，已修/在修的课按你的实际修读学期与课名显示 · 当前第 ${curSem} 学期`))

  /* 统计每学期完成度 */
  const terms = [1, 2, 3, 4, 5, 6, 7, 8]

  /* v3 学期拼图链：八个学期首尾相扣的轻量概览 */
  main.append(h('div', { class: 'card chain-card' },
    h('h3', {}, '四年节奏'),
    semChain(terms, curSem),
    h('div', { class: 'chain-foot' }, '已读实色 · 当前学期呼吸 · 未来学期虚线待拼（1 大一上 … 8 大四下）')))
  const wrap = h('div', { class: 'timeline-wrap' })

  const legend = h('div', { class: 'legend', style: 'margin-bottom:14px' },
    h('span', { class: 'lg' }, h('i', { class: 'sw pass' }), '已修'),
    h('span', { class: 'lg' }, h('i', { class: 'sw doing' }), '在修'),
    h('span', { class: 'lg' }, h('i', { class: 'sw todo' }), '未修'),
    h('span', { class: 'lg' }, h('i', { class: 'sw fail' }), '不及格'),
    h('span', { class: 'lg' }, h('i', { class: 'sw opt' }), '可选修'),
  )
  main.append(legend)

  /* 课程放置（按学生实际情况，不按方案计划名）：
     ① 有成绩记录的 → 按「实际修读学期」分列，显示实际课名与学分；
     ② 被同类别记录顶替的槽位 / 类别学分已满足的条目 → 不占时间轴；
     ③ 其余未修的 → 按方案计划学期，跨学期窗口覆盖当前学期的放当前列；
     ④ 跨四年仍在进行的认定课（学期如 2024-2028）→ 「四年内」栏 */
  const byTerm = {}
  for (const t of terms) byTerm[t] = []
  const spanItems = []
  const pushItem = (term, name, cr, k, tip) => {
    const cls = k === 'pass' ? 'pass' : k === 'doing' ? 'doing' : k === 'fail' ? 'fail' : k === 'opt' ? 'opt' : 'todo'
    const item = { name, cr, k, cls, tip }
    if (byTerm[term]) byTerm[term].push(item)
    else spanItems.push(item)
  }
  for (const p of plan.courses) {
    const s = agg.statusOf(p)
    const g = agg.gradeMap[p.code]
    if (g) {
      const t = termToSem(g.arrangement?.semester, enrollYear)
      const name = g.course?.course_name || p.name
      const cr = Number(g.course?.credit ?? p.credits)
      pushItem(t, name, cr, s.k,
        `${name} · ${cr} 学分 · ${g.arrangement?.semester || semLabel(p)} · ${s.t}\n归属：${catPath(plan, p.category_code)}`)
      continue
    }
    if (agg.borrowedMap[p.code]) continue
    if (s.k === 'pass') continue
    /* 未选的「任选」占位课（如 国际课程（项目）（任选））：不是具体的一门课，不占时间轴 */
    if (p.is_generic && p.nature === '选修') continue
    const t = (p.sem_from <= curSem && p.sem_to >= curSem) ? curSem : p.sem_from
    const rangeTxt = p.sem_from === p.sem_to ? semLabel(p) : `第${p.sem_from}-${p.sem_to}学期`
    pushItem(t, p.name, Number(p.credits), s.k,
      `${p.name} · ${Number(p.credits)} 学分 · ${rangeTxt} · ${s.t}\n归属：${catPath(plan, p.category_code)}`)
  }

  const timeline = h('div', { class: 'timeline' })
  const renderCol = (headEls, items, extraCls = '') => {
    const col = h('div', { class: 'tl-col' + extraCls })
    col.append(h('div', { class: 'tl-head' }, ...headEls))
    const body = h('div', { class: 'tl-body' })
    if (!items.length) body.append(h('div', { class: 'tl-empty' }, '—'))
    for (const it of items) {
      body.append(h('div', { class: 'tl-course ' + it.cls, title: it.tip },
        h('span', { class: 'tl-name' }, it.name),
        h('span', { class: 'tl-cr' }, it.cr),
      ))
    }
    col.append(body)
    return col
  }
  for (const t of terms) {
    const planned = (plan.term_credits || [])[t - 1] || 0
    const termStr = semToTerm(t, enrollYear)
    timeline.append(renderCol([
      h('b', {}, '第 ' + t + ' 学期'),
      t === curSem ? h('span', { class: 'tag blue' }, '当前') : null,
      h('span', { class: 'tl-plan' }, `计划 ${planned} 学分`),
      termStr && t <= curSem ? h('span', { class: 'tl-jump', title: '查看我在该学期的修课记录', onclick: () => goto('myScores', 'term-' + termStr) }, '成绩 →') : null,
    ], byTerm[t], (t === curSem ? ' now' : '') + (t < curSem ? ' past' : '')))
  }
  if (spanItems.length) {
    timeline.append(renderCol([h('b', {}, '四年内'), h('span', { class: 'tl-plan' }, '贯穿认定')], spanItems))
  }
  wrap.append(timeline)
  main.append(wrap)

  /* 各学期学分构成（可视化） */
  const stackRows = terms.map(t => {
    let pass = 0, doing = 0, rest = 0, opt = 0
    for (const it of byTerm[t]) {
      if (it.k === 'pass') pass += it.cr
      else if (it.k === 'doing') doing += it.cr
      else if (it.k === 'opt') opt += it.cr
      else rest += it.cr
    }
    const planned = (plan.term_credits || [])[t - 1] || 0
    return { t, planned, pass, doing, rest, opt, total: pass + doing + rest + opt, now: t === curSem }
  })
  main.append(h('div', { class: 'card' },
    h('h3', {}, '各学期学分构成'),
    h('p', { class: 'muted', style: 'margin-bottom:12px' },
      '柱子的总高 = 该学期培养方案里的课程学分之合，虚线 = 指导性修读计划的建议学分；当前学期带黄色底衬。'),
    vizTermStack(stackRows),
    vizLegend([
      { color: VIZ_C.green, text: '已修' },
      { color: VIZ_C.yellow, text: '在修' },
      { color: VIZ_C.redLt, text: '未完成' },
      { color: VIZ_C.track, text: '可选修' },
    ])))

  /* 每学期完成汇总 */
  const sumCard = h('div', { class: 'card' }, h('h3', {}, '各学期完成情况'))
  const tbl = h('table', { class: 'tbl' })
  tbl.append(h('tr', {}, ...['学期', '计划学分', '已修', '在修', '未完成'].map(x => h('th', {}, x))))
  for (const t of terms) {
    const list = byTerm[t]
    let pass = 0, doing = 0, rest = 0
    for (const it of list) {
      if (it.k === 'pass') pass++
      else if (it.k === 'doing') doing++
      else if (it.k !== 'opt') rest++
    }
    const rowTerm = semToTerm(t, enrollYear)
    const row = h('tr', { class: (t === curSem ? 'row-now ' : '') + (rowTerm ? 'link' : ''), title: rowTerm ? '点击查看我在该学期的修课记录' : '', onclick: rowTerm ? () => goto('myScores', 'term-' + rowTerm) : null },
      h('td', {}, '第 ' + t + ' 学期'),
      h('td', {}, (plan.term_credits || [])[t - 1] || 0),
      h('td', {}, pass + ' 门'),
      h('td', {}, doing + ' 门'),
      h('td', { style: rest ? 'color:var(--c-red);font-weight:600' : '' }, rest + ' 门'),
    )
    tbl.append(row)
  }
  sumCard.append(tbl)
  main.append(sumCard)
  main.append(h('p', { class: 'plan-note' }, '说明：一门课只出现在它「建议开课学期」（sem_from）的那一列；学分按课程学分别计，计划学分来自指导性修读计划。'))
}

/* ============================================================
 * 页面：查漏补缺（多级折叠树）
 * ============================================================ */
PAGES.myPlan = async (main) => {
  const { plan, mine, agg: computed, enrollYear } = await baseData()
  main.append(h('div', { class: 'page-title' }, '查漏补缺'))
  main.append(h('p', { class: 'page-sub' },
    `${plan.version} 版 · ${plan.major} · 毕业最低 ${plan.total_credits} 学分 · 逐级展开，红色行就是你要补的课`))
  main.append(h('p', { class: 'term-legend' }, TERM_LEGEND))

  if (!mine.length) {
    main.append(emptyBox('还没有你的修课记录',
      '现在下面所有课程都会显示为「未修」。导入成绩后才看得出真正缺什么。',
      [h('button', { class: 'btn primary', onclick: () => goto('myScores') }, '去导入成绩')]))
  }
  const agg = computed || analyzePlan(plan, [])

  /* v3 ① 大类总图：六个大类拼成一张毕业拼图，点一块可跳到下面那一类 */
  const headByCode = {}
  const overview = (() => {
    const items = agg.roots.map(r => {
      const info = agg.catProg[r.code]
      const req = info ? Number(info.req || 0) : Number(r.required_credits || 0)
      const got = info ? info.got : 0
      const prog = info ? (info.prog || 0) : 0
      const rest = info ? info.rest : req
      const k = rest <= 0 ? 'pass' : prog > 0 ? 'doing' : 'todo'
      return {
        name: r.name, credit: req, k, hex: puzColor(plan, r.code),
        tip: `${r.name}\n已获 ${n1(got)} / 共需 ${req} 学分${prog > 0 ? `（在修 ${n1(prog)}）` : ''}` +
          (rest > 0 ? `\n还差 ${n1(rest)} 学分` : '\n✓ 已达标'),
      }
    })
    return puzBlock(items, { cols: 3, cellW: 140, cellH: 86, aria: '六大类学分拼图' })
  })()
  main.append(h('div', { class: 'card puzzle-hero' },
    h('h3', {}, '毕业拼图 · 六大类'),
    h('p', { class: 'muted', style: 'margin-bottom:12px' },
      '六块碎片＝六个大类：实色＝已修满、浅色＝在修、虚线＝还缺。点一块可跳到下面那一类。'),
    overview,
    puzCatLegend(plan),
    /* 修读状态图例：一门课＝一块碎片时四种状态的颜色对照（全页只此一份） */
    (() => { const lg = puzLegend(PUZ_TOP.MAJOR); lg.classList.add('row'); return lg })()))

  const pathOf = (c) => catPath(plan, c.code)

  let onlyGap = false
  const visibleCourse = (p) => {
    if (!onlyGap) return true
    const k = agg.statusOf(p).k
    if (k === 'todo' || k === 'fail') return true
    if (k === 'opt') return agg.catDeficit(p.category_code)
    return false
  }
  const heads = [], bodies = []
  function setAll(open) {
    for (const b of bodies) b.classList.toggle('hidden', !open)
    for (const hd of heads) hd.classList.toggle('open', open)
  }
  /* 认定型实践课（美育实践 / 志愿服务 / 社会实践）：不是「选课」，只作完成认定
     （成绩栏空 = 未完成，填了 = 已完成）—— 不在类目明细里显示为课程行，状态体现在学分进度里 */
  const isPractice = (cname) => /^(美育实践|志愿服务|社会实践)$/.test((cname || '').replace(/\s/g, ''))
  function nodeStat(cat) {
    let total = 0, pass = 0, doing = 0, todo = 0, fail = 0, opt = 0
    const walk = (c) => {
      for (const p of agg.ownOf(c.code)) {
        /* 占位课（通用要求项）没真修过就不计入门数 —— 这类按「课程类别」认定，不是必须修名单里的课 */
        if (p.is_generic && !agg.gradeMap[p.code]) continue
        /* 认定型实践课不计入课程行与门数 */
        if (isPractice(agg.gradeMap[p.code]?.course?.course_name || p.name)) continue
        /* 被同类别记录顶替的槽位不重复计数 */
        if (agg.borrowedMap[p.code]) continue
        const k = agg.statusOf(p).k
        /* 没选的选修课不计入门数（表格里同样不显示，两处口径保持一致） */
        if (k === 'opt') continue
        total++
        if (k === 'pass') pass++
        else if (k === 'doing') doing++
        else if (k === 'fail') fail++
        else if (k === 'todo') todo++
      }
      for (const ch of agg.childOf(c.code)) walk(ch)
    }
    walk(cat)
    return { total, pass, doing, todo, fail, opt }
  }
  /* 学生成绩里、类别解析为该类目、但不对应本类任何方案条目的课（补充行，防止漏显示） */
  function studentRowsInCat(code) {
    const ownCodes = new Set(agg.ownOf(code).map(p => p.code))
    return mine.filter(s => {
      const cname = s.course?.course_name
      const pc = s.course ? (plan.byCode[s.course.plan_code || s.course.course_id] || matchPlanCourse(plan, cname, s.course.credit)) : null
      if (!pc || pc.category_code !== code) return false
      return !ownCodes.has(pc.code)
    })
  }
  function studentRow(s) {
    const prac = isPractice(s.course?.course_name)
    /* 已完成判定：状态不是「在修」即完成 —— 认定型实践课（无成绩已认定）、
       无绩点模式导入的已结业课（有完成状态但分数未入库）、正常出分的课 */
    const noScore = s.total_score === null || s.total_score === undefined
    const done = s.status !== '在修'
    const good = done && (noScore || Number(s.total_score) >= 60)
    const st = !done ? { t: '在修', cls: 'blue' } : good ? { t: prac ? '已认定' : (noScore ? '已修·不计分' : '已修'), cls: 'green' } : { t: '未通过', cls: 'red' }
    return h('tr', { class: done && !good ? 'row-gap' : '' },
      h('td', {}, s.course?.course_name || '—'),
      h('td', {}, s.course?.credit ?? '—'),
      h('td', {}, termCN(s.arrangement?.semester, enrollYear) || s.arrangement?.semester || '—'),
      h('td', {}, h('span', { class: 'tag gray', title: '按「课程类别」归入这一类' }, '按类别')),
      h('td', {}, h('span', { class: 'tag ' + st.cls }, st.t)),
      h('td', {}, prac ? (done ? '（已认定）' : '—') : (noScore ? (done ? '（不计分）' : '—') : fmtScore(s.total_score))),
    )
  }
  function courseTable(list, extras = []) {
    /* 类目内容以学生实际修的课程为准：占位课（通用要求项）只有真修过才显示；
       认定型实践课不作课程行；被顶替的槽位不重复列行。
       选修课没选的也照样列出（灰色「可选」标签）—— 看表就知道这一类还能去选哪些课，
       类目修满后「只看未完成项」模式下会自动收起（visibleCourse 里按缺口过滤） */
    const rows = list.filter(p => {
      if (!visibleCourse(p)) return false
      if (p.is_generic && !agg.gradeMap[p.code]) return false
      /* 认定型实践课（美育实践等）照常列行：它们计入了「已获」学分，必须显示出来才能对上账
         （状态列由 statusOf 给出「已修/在修」，成绩列为空） */
      /* 被同类别学生实际修的课顶替的槽位：不重复列一行（如「创新创业实践」由「常见动物中毒…」顶） */
      if (agg.borrowedMap[p.code]) return false
      /* 特殊规定：国际课程（项目）培养方案口径不清（项目内课程不逐门列池），只显示实际选了的课 */
      if (p.category_code === 'MAJOR_INTL' && agg.statusOf(p).k === 'opt') return false
      return true
    })
    /* 按显示的开课学期编号排序（实际修读学期优先，其次方案计划学期；范围的取起始学期） */
    const termNumOf = (p) => {
      const t = termCN(agg.gradeMap[p.code]?.arrangement?.semester, enrollYear)
      return t && /^\d+$/.test(t) ? +t : p.sem_from || 99
    }
    rows.sort((a, b) => termNumOf(a) - termNumOf(b))
    const exRows = extras.filter(s => {
      if (!onlyGap) return true
      const done = s.total_score !== null && s.total_score !== undefined
      return done && Number(s.total_score) < 60
    })
    const exNumOf = (s) => {
      const t = termCN(s.arrangement?.semester, enrollYear)
      return t && /^\d+$/.test(t) ? +t : 99
    }
    exRows.sort((a, b) => exNumOf(a) - exNumOf(b))
    if (!rows.length && !exRows.length) return null
    const tbl = h('table', { class: 'tbl' })
    tbl.append(h('tr', {}, ...['课程名称', '学分', '开课学期', '性质', '我的状态', '成绩'].map(x => h('th', {}, x))))
    for (const p of rows) {
      const s = agg.statusOf(p)
      const g = agg.gradeMap[p.code]
      /* 行内容以学生实际修的课为准：方案里写的是「体育（一）」这类通用要求项，
         学生实际修的是「球类B」「游泳A」—— 显示学生自己课程表里的课名与修读学期 */
      const nm = g?.course?.course_name || p.name
      const credits = Number(g?.course?.credit ?? p.credits)
      /* 开课学期用学期编号（1-8，页面顶部有注释）：优先实际修读学期，其次方案计划学期 */
      const term = termCN(g?.arrangement?.semester, enrollYear)
        || (p.sem_from === p.sem_to ? String(p.sem_from) : `${p.sem_from}-${p.sem_to}`)
      tbl.append(h('tr', { class: s.k === 'opt' ? 'row-opt' : (s.k === 'todo' || s.k === 'fail') ? 'row-gap' : '' },
        h('td', {}, nm),
        h('td', {}, credits),
        h('td', {}, term),
        h('td', {}, h('span', { class: 'tag ' + (p.nature === '必修' ? 'blue' : 'gray') }, p.nature)),
        h('td', {}, h('span', { class: 'tag ' + s.cls }, s.t)),
        h('td', {}, g ? (g.total_score !== null && g.total_score !== undefined ? fmtScore(g.total_score) : (g.status !== '在修' ? '（不计分）' : '—')) : '—'),
      ))
    }
    for (const s of exRows) tbl.append(studentRow(s))
    return tbl
  }
  /* v3 ② 类内拼图：一个大类一张拼图，一门课＝一块碎片（颜色＝本类目色，形态＝修读状态）。
     只收「真修的课 + 必修待补的课」：未选的选修课不计入，免得拼图被可选课撑爆且没信息量。 */
  function catPuzzle(cat) {
    const items = []
    for (const code of agg.subtreeOf(cat.code)) {
      for (const p of agg.ownOf(code)) {
        const g = agg.gradeMap[p.code]
        if (p.is_generic && !g) continue
        const nm = g?.course?.course_name || p.name
        if (isPractice(nm)) continue
        if (agg.borrowedMap[p.code]) continue
        const k = agg.statusOf(p).k
        if (k === 'opt' && !g) continue
        const cr = Number(g?.course?.credit ?? p.credits)
        items.push({
          name: nm, credit: cr, k, hex: puzColor(plan, cat.code),
          tip: `${nm} · ${cr} 学分 · ${agg.statusOf(p).t}\n归属：${catPath(plan, p.category_code)}`,
        })
      }
    }
    if (items.length < 2) return null
    const cols = items.length <= 4 ? 2 : items.length <= 9 ? 3 : 4
    return h('div', { class: 'cat-puzzle' },
      puzBlock(items, {
        cols, cellW: 118, cellH: 76,
        complete: items.every(x => x.k === 'pass' || x.k === 'opt'),
        aria: cat.name + '拼图',
      }))
    /* 状态图例不再逐类重复：页面顶部「毕业拼图」卡片里已放一份 */
  }
  function nodeBox(cat, depth) {
    const kids = agg.childOf(cat.code)
    const own = agg.ownOf(cat.code)
    const st = nodeStat(cat)
    const info = agg.catProg[cat.code]
    const req = info ? info.req : 0
    const got = info ? info.got : agg.effSum(agg.earned, cat)
    const rest = info ? info.rest : 0

    const body = h('div', { class: 'plan-body hidden' })
    /* v3 ② 类内拼图（仅顶层大类，子级不再重复） */
    if (depth === 1) { const pz = catPuzzle(cat); if (pz) body.append(pz) }
    if (cat.note) body.append(h('p', { class: 'plan-note' }, cat.note))
    if (info) {
      const subReqs = agg.subReqNames(cat)
      if (subReqs.length) body.append(h('p', { class: 'plan-note' },
        `本级要求 ${info.req} 学分，与下属要求项分别达标（不含 ${subReqs.join('、')}）`))
    }
    const kidBoxes = []
    for (const ch of kids) { const bx = nodeBox(ch, depth + 1); if (bx) kidBoxes.push(bx) }
    const ownTbl = courseTable(own, studentRowsInCat(cat.code))
    const ownGenerics = own.filter(p => p.is_generic)
    /* 类内没有任何可显示的行：若该类是「按类别认定」的（方案里只写了占位课），给一句引导而不是空白 */
    if (!ownTbl && ownGenerics.length && !kidBoxes.length) {
      body.append(h('p', { class: 'plan-note' },
        `这一类按「课程类别」认定，方案里不指定具体课程：导入成绩后，类别为「${cat.name}」的课会自动归到这里。`))
    }
    if (onlyGap && !kidBoxes.length && !ownTbl && !(info && info.rest > 0)) return null
    for (const bx of kidBoxes) body.append(bx)
    if (ownTbl) {
      if (kidBoxes.length) body.append(h('p', { class: 'plan-note' }, `${cat.name}本级课程：`))
      body.append(h('div', { class: 'plan-tbl' }, ownTbl))
    }

    /* 学分三段式：已获 + 在修 + 还差 = 共需，一眼看懂（替代原来「门数 · 已获 x/y」的混排） */
    const prog = info ? info.prog : 0
    const metaEl = req
      ? h('span', { class: 'meta' },
        h('b', { class: 'm-got' }, `已获 ${n1(got)}`),
        prog > 0 ? h('span', { class: 'm-prog' }, ` + 在修 ${n1(prog)}`) : null,
        h('span', {}, ` / 共需 ${Number(req)} 学分`),
      )
      : h('span', { class: 'meta' },
        st.total ? `已修 ${st.pass}/${st.total} 门` + (st.doing ? ` · 在修 ${st.doing} 门` : '') : '—')
    const head = h('div', { class: 'plan-head lv' + Math.min(depth, 3) + (rest > 0 ? ' has-gap' : ''), title: pathOf(cat) },
      h('span', { class: 'caret' }, '▸'),
      h('span', { class: 'nm' }, cat.name),
      req ? h('span', { class: 'req' }, `≥${Number(req)} 学分`) : null,
      metaEl,
      /* 已达标只看实修学分：在修学分只把缺口抵消，不算达标（如美育 0/2 但全在修 → 显示「在修中」） */
      req
        ? (rest > 0
          ? h('span', { class: 'gap' }, `还差 ${n1(rest)} 学分`)
          : (info && info.prog > 0 && got < req
            ? h('span', { class: 'doing' }, '在修中')
            : h('span', { class: 'ok' }, '已达标')))
        /* 无学分要求的类目（按学时/门数认定，如劳育类 ≥32 学时）：同样给状态标签，格式与上面统一 */
        : (st.todo + st.fail > 0
          ? h('span', { class: 'gap soft' }, `${st.todo + st.fail} 门待修`)
          : st.doing > 0
            ? h('span', { class: 'doing' }, '在修中')
            : (st.total > 0 ? h('span', { class: 'ok' }, '已完成') : null)),
    )
    head.addEventListener('click', () => {
      const willOpen = body.classList.contains('hidden')
      body.classList.toggle('hidden', !willOpen)
      head.classList.toggle('open', willOpen)
    })
    heads.push(head); bodies.push(body)
    headByCode[cat.code] = head
    return h('div', { class: 'plan-node' }, head, body)
  }

  const card = h('div', { class: 'card' }, h('h3', {}, '培养方案逐级对照'))
  const treeWrap = h('div')
  function renderTree() {
    treeWrap.innerHTML = ''
    heads.length = 0; bodies.length = 0
    for (const r of agg.roots) { const bx = nodeBox(r, 1); if (bx) treeWrap.append(bx) }
    if (!treeWrap.children.length) treeWrap.append(h('p', { class: 'empty' }, '🎉 本方案内已无未完成课程'))
  }
  const chk = h('input', { type: 'checkbox' })
  chk.addEventListener('change', () => { onlyGap = chk.checked; renderTree(); if (onlyGap) setAll(true) })
  card.append(h('div', { class: 'plan-tools' },
    h('label', { class: 'chk' }, chk, h('span', {}, '只看未完成项')),
    h('span', { class: 'muted', style: 'margin-left:auto' }, '点击任一层级展开 / 收起'),
    h('button', { class: 'btn sm primary', onclick: () => setAll(true) }, '全部展开'),
    h('button', { class: 'btn sm', onclick: () => setAll(false) }, '全部收起'),
  ))
  card.append(treeWrap)
  main.append(card)
  renderTree()

  /* 大类总图点击 → 展开并跳转到对应大类的节点 */
  overview.querySelectorAll('.frag').forEach((g, i) => {
    const r = agg.roots[i]
    const hd = r && headByCode[r.code]
    if (!hd) return
    g.style.cursor = 'pointer'
    g.addEventListener('click', () => {
      const bd = hd.parentElement && hd.parentElement.querySelector('.plan-body')
      if (bd && bd.classList.contains('hidden')) { bd.classList.remove('hidden'); hd.classList.add('open') }
      hd.scrollIntoView({ block: 'center' })
      hd.classList.add('anchor-flash')
      setTimeout(() => hd.classList.remove('anchor-flash'), 1800)
    })
  })

  /* 方案外已修课程 */
  if (agg.extraCourses.length) {
    const tbl = h('table', { class: 'tbl' })
    tbl.append(h('tr', {}, ...['课程名称', '学分', '总评', '说明'].map(x => h('th', {}, x))))
    for (const s of agg.extraCourses) tbl.append(h('tr', {},
      h('td', {}, s.course.course_name), h('td', {}, s.course.credit),
      h('td', {}, fmtScore(s.total_score)),
      h('td', { class: 'muted' }, '不在培养方案课程表里，一般不计入毕业要求'),
    ))
    main.append(h('div', { class: 'card' }, h('h3', {}, `方案外已修课程（${agg.extraCourses.length} 门）`), tbl))
  }

  /* 继续探索：与其他页面的数据互通 */
  main.append(h('div', { class: 'toolbar', style: 'margin-top:16px' },
    h('button', { class: 'btn sm primary', onclick: () => goto('myAdvice') }, '看本学期该选什么课 →'),
    h('button', { class: 'btn sm', onclick: () => goto('myScores', 'doing') }, '查看在修课程 →'),
    h('button', { class: 'btn sm', onclick: () => goto('myScores', 'fail') }, '查看不及格记录 →'),
  ))
}

/* ============================================================
 * 页面：方案解读
 * ============================================================ */
PAGES.myPlanRead = async (main) => {
  const { plan, curSem, agg } = await baseData()
  main.append(h('div', { class: 'page-title' }, '方案解读'))
  main.append(h('p', { class: 'page-sub' },
    `按培养方案原文逐项梳理 · ${plan.source} · ${plan.school} · 学制 ${plan.years} 年 · 授予 ${plan.degree}`))

  /* 总账 */
  const rootCards = h('div', { class: 'mod-grid' })
  for (const root of agg ? agg.roots : plan.cats.filter(c => !c.parent_code).sort((a, b) => a.sort - b.sort)) {
    const code = root.code
    const intro = (plan.intro || {})[code] || {}
    const info = agg?.catProg[code]
    const req = info ? info.req : Number(root.required_credits || 0)
    const got = info ? info.got : 0
    const prog = info ? (info.prog || 0) : 0
    const rest = info ? info.rest : req
    const pct = req ? got / req * 100 : 0
    const card = h('div', { class: 'mod-card' + (rest > 0 ? ' has-gap' : '') })
    card.append(h('div', { class: 'mod-head' },
      h('b', {}, root.name),
      h('span', { class: 'mod-req' }, `≥${req} 学分`),
      /* 与查漏补缺页同一口径：在修学分不算达标 */
      rest > 0 ? h('span', { class: 'tag red' }, `还差 ${n1(rest)}`)
        : (prog > 0 && got < req ? h('span', { class: 'tag blue' }, '在修中') : h('span', { class: 'tag green' }, '已达标')),
    ))
    if (agg) {
      card.append(h('div', { class: 'mod-bar' }, progressBar(pct)))
      card.append(h('div', { class: 'mod-num' }, `已获 ${n1(got)} / ${req} 学分` + (prog > 0 ? ` · 在修 ${n1(prog)}` : '')))
    }
    if (intro.simple) card.append(h('p', { class: 'mod-simple' }, intro.simple))
    if (intro.when) card.append(h('p', { class: 'mod-when' }, h('b', {}, '什么时候修：'), intro.when))
    if (intro.tips?.length) {
      const ul = h('ul', { class: 'mod-tips' })
      for (const t of intro.tips) ul.append(h('li', {}, t))
      card.append(ul)
    }
    /* 子项明细 */
    const kids = agg ? agg.childOf(code) : plan.cats.filter(c => c.parent_code === code).sort((a, b) => a.sort - b.sort)
    if (kids.length) {
      const sub = h('div', { class: 'mod-kids' })
      for (const k of kids) {
        const ki = agg?.catProg[k.code]
        sub.append(h('span', { class: 'mod-kid' },
          k.name,
          ki ? h('i', { class: ki.rest > 0 ? 'bad' : 'ok' }, `${n1(ki.got)}/${Number(ki.req)}`) : (k.required_credits != null ? h('i', {}, `${Number(k.required_credits)} 学分`) : h('i', {}, '—')),
        ))
      }
      card.append(sub)
    }
    rootCards.append(card)
  }
  main.append(rootCards)

  /* 学期分布 */
  const distCard = h('div', { class: 'card' }, h('h3', {}, '指导性修读计划：各学期学分'))
  const dist = h('div', { class: 'dist' })
  for (let t = 1; t <= plan.years * 2; t++) {
    const v = (plan.term_credits || [])[t - 1] || 0
    const col = h('div', { class: 'dist-col' + (t === curSem ? ' now' : '') })
    col.append(h('div', { class: 'dist-bar' }, h('div', { class: 'dist-fill', style: `height:${Math.min(100, v / 30 * 100)}%` })))
    col.append(h('div', { class: 'dist-v' }, v))
    col.append(h('div', { class: 'dist-t' }, '第' + t + '学期'))
    dist.append(col)
  }
  distCard.append(dist)
  const notes = h('ul', { class: 'term-notes' })
  for (let t = 1; t <= plan.years * 2; t++) {
    const note = (plan.term_notes || [])[t - 1]
    if (note) notes.append(h('li', {}, h('b', {}, '第 ' + t + ' 学期：'), note))
  }
  distCard.append(notes)
  main.append(distCard)

  /* 避坑提醒 */
  const pitCard = h('div', { class: 'card' }, h('h3', {}, '容易踩的坑'))
  for (const p of plan.pitfalls || []) {
    pitCard.append(h('div', { class: 'pit ' + p.level },
      h('b', {}, p.title),
      h('p', {}, p.text),
    ))
  }
  main.append(pitCard)

  /* 继续探索：与其他页面的数据互通 */
  main.append(h('div', { class: 'toolbar', style: 'margin-top:16px' },
    h('button', { class: 'btn sm primary', onclick: () => goto('myPlan') }, '逐级展开看缺口 →'),
    h('button', { class: 'btn sm', onclick: () => goto('myTimeline') }, '看各学期安排 →'),
  ))
}

/* ============================================================
 * 页面：方案树状解读（内嵌按培养方案原文整理的树状页）
 * ============================================================ */
PAGES.myPlanTree = async (main) => {
  const plan = await loadPlan()
  main.append(h('div', { class: 'page-title' }, '方案树状解读'))
  main.append(h('p', { class: 'page-sub' },
    `${plan.version} 版 · ${plan.major} · 16 个最细分类与选课系统一致 · 点击任意条目展开 / 收起`))
  main.append(h('iframe', {
    src: 'assets/plan-tree.html',
    title: '培养方案树状解读',
    style: 'width:100%; height:calc(100vh - 130px); min-height:600px; border:0; border-radius:14px; background:#fff; box-shadow:0 4px 0 rgba(74,69,53,.18);',
  }))
}

/* ============================================================
 * 页面：我的课程（成绩列表 + 自助导入）
 * ============================================================ */
PAGES.myScores = async (main) => {
  const plan = await loadPlan()
  main.append(h('div', { class: 'page-title' }, '我的课程'))
  const ctx = await loadContext()
  const mine = await loadMyScores(ctx)
  main.append(h('p', { class: 'page-sub' }, '这里是你自己导入的修课记录。导入后，所有页面的进度与建议都会自动重算。'))

  /* --- 导入区 --- */
  const impCard = h('div', { class: 'card' }, h('h3', {}, '导入 / 更新成绩'))
  impCard.append(h('p', { class: 'muted' },
    '最省事的做法：直接把教务系统导出的 PDF 丢进来 —— 「成绩单（已获得成绩）」和「正在修读课表」都能自动识别，不用先整理成表格；**可以一次选中两个文件**（按住 Ctrl 多选），系统会合并解析、同名同学期的课自动去重。系统以「课程类别」为学分归属的核心依据；课名没出现在培养方案里也不影响，确认一下即可。'))
  impCard.append(h('p', { class: 'muted' },
    '三个特殊实践课（美育实践四年累计 ≥16 小时、志愿服务四年累计 ≥20 小时、社会实践在大二下学期后的暑假完成）不打分、只认定完成与否 —— 第一次导入成功后会弹窗问你这三门完成没有：选「已完成」即认定 1 学分，选「未完成」先记为进行中，之后完成可在课程列表里改。'))
  impCard.append(h('p', { class: 'muted' },
    '绩点：绝大多数课程计入平均学分绩点；MOOC / 智慧树课程、体育课、国际课程（项目）、创新创业实践、大学生创新创业基础、大学生心理素质拓展，以及没写成绩的课程默认不计入 —— 你可以随时在预览或课程列表里逐条改。成绩单上标「#」的课按学校口径不计入 GPA。'))
  impCard.append(h('p', { class: 'muted', style: 'margin-top:10px' },
    h('label', { style: 'cursor:pointer; user-select:none' },
      Object.assign(h('input', { type: 'checkbox', style: 'vertical-align:-2px; margin-right:6px' }),
        { checked: !!state.privacyMode,
          onchange: (e) => { state.privacyMode = e.target.checked } }),
      ' 无绩点模式（不想让成绩出现在系统里就勾上）：分数与绩点一律不读取、不入库 —— ' +
      '成绩单（已结业）里的课程按「已修读完成」认定，课表里的按在修；谁（包括管理员）都看不到你的分数。')))
  impCard.append(h('div', { class: 'toolbar', style: 'margin-top:12px' },
    h('button', { class: 'btn primary', onclick: () => $('impFile').click() }, '选择文件并导入（PDF / Excel，可多选）'),
    h('button', { class: 'btn', onclick: addOne }, '手动添加一门课程'),
    h('input', { type: 'file', id: 'impFile', accept: '.pdf,.xlsx,.xls,.csv', multiple: '', style: 'display:none', onchange: onFile }),
  ))
  const result = h('div')
  impCard.append(result)
  main.append(impCard)

  /* 上次解析了但还没确认导入的预览：切页回来自动恢复，不用重新选文件 */
  if (state.importDraft && state.importDraft.length) {
    renderPreview(state.importDraft)
    toast(`已恢复上次未导入的预览（${state.importDraft.length} 条），可继续核对或导入`, 'ok')
  }

  /* --- 成绩列表 --- */
  const byTerm = {}
  for (const s of mine) {
    const t = s.arrangement?.semester || '未知学期'
    ;(byTerm[t] = byTerm[t] || []).push(s)
  }
  const withGp = mine.filter(s => s.gp !== null && s.gp !== undefined && s.course && s.count_gp !== false)
  const totalCredit = withGp.reduce((sum, s) => sum + Number(s.course.credit), 0)
  const gpa = totalCredit ? (withGp.reduce((sum, s) => sum + Number(s.gp) * Number(s.course.credit), 0) / totalCredit) : 0
  const noGpN = mine.filter(s => s.count_gp === false && s.total_score !== null).length
  const passedN = mine.filter(s => (s.total_score !== null && Number(s.total_score) >= 60)
    || (s.total_score === null && s.status !== '在修')).length   // 含无绩点模式的已结业课
  const failedN = mine.filter(s => s.total_score !== null && Number(s.total_score) < 60).length

  /* 统计卡可点：跳到下方对应的具体记录（同页滚动定位 + 高亮） */
  const jumpInPage = (name) => {
    const el = document.querySelector('#main [data-anchor="' + name + '"]')
    if (!el) { toast('没有找到对应的记录', 'err'); return }
    el.scrollIntoView({ block: 'center' })
    el.classList.add('anchor-flash')
    setTimeout(() => el.classList.remove('anchor-flash'), 1800)
  }
  const doingN = mine.filter(s => s.status === '在修').length
  main.append(h('div', { class: 'stat-grid' },
    h('div', { class: 'stat', title: `由 ${withGp.length} 门已出成绩且计入绩点的课程加权计算，共 ${n1(totalCredit)} 学分` },
      h('b', {}, gpa.toFixed(2)), h('span', {}, `平均学分绩点（${withGp.length} 门 · ${n1(totalCredit)} 学分）`)),
    h('div', { class: 'stat' }, h('b', {}, passedN), h('span', {}, '已通过课程（门）')),
    failedN ? h('div', { class: 'stat warn link', title: '点击定位到不及格的记录', onclick: () => jumpInPage('fail') }, h('b', {}, failedN), h('span', {}, '不及格（门）'))
            : h('div', { class: 'stat warn' }, h('b', {}, failedN), h('span', {}, '不及格（门）')),
    doingN ? h('div', { class: 'stat link', title: '点击定位到在修课程', onclick: () => jumpInPage('doing') }, h('b', {}, doingN), h('span', {}, '在修（门）'))
           : h('div', { class: 'stat' }, h('b', {}, doingN), h('span', {}, '在修（门）')),
    noGpN ? h('div', { class: 'stat link', title: '点击定位到不计入绩点的课程', onclick: () => jumpInPage('nogp') }, h('b', {}, noGpN), h('span', {}, '不计入绩点（门）'))
          : h('div', { class: 'stat' }, h('b', {}, noGpN), h('span', {}, '不计入绩点（门）')),
  ))

  /* 各学期成绩走势（可视化） */
  const shortTerm = (k) => String(k).replace(/^20(\d{2})-20(\d{2})-(\d)$/, '$1-$2-$3')
  const trendPts = Object.keys(byTerm).sort().map(k => {
    const list = byTerm[k].filter(s => s.total_score !== null && s.total_score !== undefined)
    if (!list.length) return null
    const wOf = (s) => Number(s.course?.credit || 0) || 1
    const wSum = list.reduce((a, s) => a + wOf(s), 0)
    const avg = list.reduce((a, s) => a + Number(s.total_score) * wOf(s), 0) / wSum
    const gpList = list.filter(s => s.gp !== null && s.gp !== undefined && s.count_gp !== false)
    const gpW = gpList.reduce((a, s) => a + wOf(s), 0)
    const gp = gpW ? gpList.reduce((a, s) => a + Number(s.gp) * wOf(s), 0) / gpW : null
    return { label: shortTerm(k), avg, gp, n: list.length }
  }).filter(Boolean)
  if (trendPts.length) {
    main.append(h('div', { class: 'card' },
      h('h3', {}, '各学期成绩走势'),
      h('p', { class: 'muted', style: 'margin-bottom:10px' },
        '按学期加权平均分（学分越高的课权重越大）；点下方小字是该学期平均学分绩点。留空的「在修」课程不计入。'),
      vizScoreLine(trendPts),
      vizLegend([
        { color: VIZ_C.green, text: '学期加权平均分' },
      ])))
  }

  const listCard = h('div', { class: 'card' }, h('h3', {}, `我的修课记录（${mine.length} 条）`))
  listCard.append(h('p', { class: 'muted', style: 'margin:2px 0 10px' },
    '逐条可改：点「改」调整课程类别（学分归属）、成绩、学分与学期，以及是否计入绩点；点「删」移除该条。已出成绩的课，点绩点列的小标签即可切换是否计入；在修的课要等出分后才会判定。'))
  listCard.append(h('p', { class: 'muted', style: 'margin:0 0 10px' },
    '批量处理：勾选左侧方框（表头方框可整学期全选），再在上面那条工具条里统一「计入 / 不计入绩点」或删除。'))

  /* ---- 批量处理：勾选若干条记录 → 统一改绩点开关 / 批量删除 ---- */
  const selIds = new Set()      /* 已勾选的 score_id（统一按字符串存） */
  const rowChecks = []          /* { id, cb, tr, term } */
  const termChecks = []         /* { t, cb } */
  const selBar = h('div', { class: 'sel-bar hidden' })
  const syncSelBar = () => {
    selBar.innerHTML = ''
    selBar.classList.toggle('hidden', selIds.size === 0)
    if (!selIds.size) return
    selBar.append(
      h('span', { class: 'sel-info' }, `已选 ${selIds.size} 条`),
      h('button', { class: 'btn sm', onclick: () => batchGp(false) }, '批量设为不计入绩点'),
      h('button', { class: 'btn sm', onclick: () => batchGp(true) }, '批量设为计入绩点'),
      h('button', { class: 'btn sm danger', onclick: () => batchDel() }, '批量删除'),
      h('button', { class: 'btn sm ghost', onclick: clearSel }, '取消选择'),
    )
  }
  function clearSel() {
    selIds.clear()
    for (const r of rowChecks) { r.cb.checked = false; r.tr.classList.remove('row-sel') }
    for (const c of termChecks) c.cb.checked = false
    syncSelBar()
  }
  listCard.append(selBar)

  const terms = Object.keys(byTerm).sort()
  if (!terms.length) {
    listCard.append(h('p', { class: 'empty' }, '还没有记录，先在上方导入成绩单，或点「手动添加一门课程」。'))
  }
  let doneDoing = false, doneFail = false, doneNogp = false
  for (const t of terms) {
    listCard.append(h('div', { class: 'term-title', 'data-anchor': 'term-' + t }, t))
    /* 各学期表格用同一套列宽（tbl-fixed + colgroup），跨学期横向对齐 */
    const tbl = h('table', { class: 'tbl tbl-fixed' })
    tbl.append(h('colgroup', {},
      h('col', { style: 'width:36px' }),
      h('col', {}),
      h('col', { style: 'width:52px' }),
      h('col', { style: 'width:60px' }),
      h('col', { style: 'width:118px' }),
      h('col', { style: 'width:88px' }),
      h('col', { style: 'width:27%' }),
      h('col', { style: 'width:112px' }),
    ))
    /* 表头方框：整学期全选 / 全不选 */
    const headCb = h('input', { type: 'checkbox', class: 'row-check', title: '全选本学期的记录' })
    headCb.addEventListener('change', () => {
      for (const r of rowChecks) {
        if (r.term !== t) continue
        r.cb.checked = headCb.checked
        r.tr.classList.toggle('row-sel', headCb.checked)
        if (headCb.checked) selIds.add(r.id); else selIds.delete(r.id)
      }
      syncSelBar()
    })
    termChecks.push({ t, cb: headCb })
    tbl.append(h('tr', {}, h('th', { class: 'th-sel' }, headCb),
      ...['课程名称', '学分', '总评', '绩点', '状态', '学分归属', '操作'].map(x => h('th', {}, x))))
    for (const s of byTerm[t]) {
      const pc = plan.byCode[s.course?.plan_code || s.course?.course_id] || matchPlanCourse(plan, s.course?.course_name, s.course?.credit)
      const bad = s.total_score !== null && Number(s.total_score) < 60
      const counted = s.count_gp !== false
      /* 在修（没成绩）的课无法计入绩点，不能给可点标签 —— 否则点了没反应，像坏了一样
         三门认定型实践课（美育实践/志愿服务/社会实践）永远不出分：完成即认定，标「无需成绩」而不是「待出分」 */
      const hasScore = s.total_score !== null && s.total_score !== undefined
      const isPrac = isPracticeCourse(s.course?.course_name)
      const gpTag = hasScore
        ? h('span', {
            class: 'tag ' + (counted ? 'green' : 'gray'), style: 'cursor:pointer;margin-left:6px',
            title: '点击切换：计入 / 不计入平均学分绩点',
            onclick: () => toggleGp(s),
          }, counted ? '计入' : '不计入')
        : isPrac
          ? h('span', {
              class: 'tag gray', style: 'margin-left:6px;opacity:.65;cursor:default',
              title: '认定型实践课不打分：状态「已完成」即认定学分，不参与平均学分绩点计算',
            }, '无需成绩')
          : h('span', {
              class: 'tag gray', style: 'margin-left:6px;opacity:.65;cursor:default',
              title: '还没有成绩（在修），出分后系统会自动判定是否计入，届时可点标签手动调整',
            }, '待出分')
      /* 给「第一条」在修 / 不及格 / 不计入绩点的行打锚点，供统计卡与跨页跳转定位 */
      const anchor = {};
      if (!doneDoing && s.total_score === null && !(isPrac && s.status !== '在修')) { anchor['data-anchor'] = 'doing'; doneDoing = true }
      else if (!doneFail && bad) { anchor['data-anchor'] = 'fail'; doneFail = true }
      else if (!doneNogp && !counted) { anchor['data-anchor'] = 'nogp'; doneNogp = true }
      const tr = h('tr', { class: bad ? 'row-gap' : '', ...anchor })
      const cb = h('input', { type: 'checkbox', class: 'row-check' })
      cb.addEventListener('change', () => {
        if (cb.checked) selIds.add(String(s.score_id)); else selIds.delete(String(s.score_id))
        tr.classList.toggle('row-sel', cb.checked)
        const tc = termChecks.find(x => x.t === t)
        if (tc) tc.cb.checked = rowChecks.filter(r => r.term === t).every(r => r.cb.checked)
        syncSelBar()
      })
      tr.append(
        h('td', { class: 'td-sel' }, cb),
        h('td', {}, (() => {
          /* v3：课名前挂一枚小拼图块（颜色＝类目，形态＝状态） */
          const kind = s.total_score === null ? (s.status !== '在修' ? 'pass' : 'doing') : (bad ? 'fail' : 'pass')
          const ic = h('span', { class: 'name-ic' })
          ic.innerHTML = puzChip(pc ? puzColor(plan, pc.category_code) : VIZ_C.leaf, kind)
          return ic
        })(), s.course?.course_name || '—'),
        h('td', {}, s.course?.credit ?? '—'),
        h('td', {}, fmtScore(s.total_score)),
        h('td', {}, s.gp === null || s.gp === undefined ? '—' : Number(s.gp).toFixed(1), gpTag),
        h('td', {}, h('span', { class: 'tag ' + (s.total_score === null ? (s.status !== '在修' ? 'green' : 'blue') : bad ? 'red' : 'green') },
          s.total_score === null
            ? (s.status !== '在修' ? '已完成·不计分' : '在修')
            : bad ? '不及格' : '通过')),
        h('td', { class: 'muted' }, pc ? catPath(plan, pc.category_code) : '方案外'),
        h('td', {}, h('div', { class: 'toolbar', style: 'gap:6px' },
          h('button', { class: 'btn sm', onclick: () => editRow(s) }, '改'),
          h('button', { class: 'btn sm', onclick: () => delRow(s) }, '删'),
        )),
      )
      rowChecks.push({ id: String(s.score_id), cb, tr, term: t })
      tbl.append(tr)
    }
    listCard.append(tbl)
  }
  if (mine.length) listCard.append(h('div', { class: 'toolbar', style: 'margin-top:12px' },
    h('button', { class: 'btn sm', onclick: exportMine }, '导出我的成绩单 Excel')))
  main.append(listCard)

  /* ---- 逐条维护：快速切换绩点 / 编辑 / 删除 ---- */
  async function toggleGp(s) {
    await guard(async () => {
      const next = s.count_gp === false
      /* 本地预估切换后的绩点：单门课权重小时两位小数看不出变化，提示里给足信息 */
      const gpaOf = (list) => {
        const g = list.filter(x => x.gp !== null && x.gp !== undefined && x.course && x.count_gp !== false)
        const c = g.reduce((a, x) => a + Number(x.course.credit || 0), 0)
        return c ? g.reduce((a, x) => a + Number(x.gp) * Number(x.course.credit || 0), 0) / c : 0
      }
      const before = gpaOf(mine)
      const after = gpaOf(mine.map(x => x.score_id === s.score_id ? { ...x, count_gp: next } : x))
      await dbRpc('update_student_score', {
        p_score_id: s.score_id,
        p_score: s.total_score,
        p_count_gp: next,
      })
      const moved = Math.abs(after - before) >= 0.005
      toast(`已改为「${next ? '计入' : '不计入'}绩点」` + (moved
        ? ` · 平均学分绩点 ${before.toFixed(2)} → ${after.toFixed(2)}`
        : ` · 平均学分绩点仍是 ${after.toFixed(2)}（该课学分少，对均值影响不到 0.01）`), 'ok')
      goto('myScores')
    })
  }

  function rowFormValues(s) {
    const pc = plan.byCode[s?.course?.plan_code || s?.course?.course_id] || (s ? matchPlanCourse(plan, s.course?.course_name, s.course?.credit) : null)
    const catName = pc ? (plan.cats.find(c => c.code === pc.category_code)?.name || '') : ''
    return {
      sem: s?.arrangement?.semester || '',
      name: s?.course?.course_name || '',
      credit: s?.course?.credit ?? '',
      cat: catName,
      score: s?.total_score ?? '',
      count_gp: s ? (s.count_gp === false ? 'false' : 'true') : 'auto',
    }
  }
  function catOptions() {
    return [{ value: '', text: '— 请选择 —' }].concat(leafCatNames(plan).map(n => ({ value: n })))
  }

  function editRow(s) {
    const v = rowFormValues(s)
    openModal({
      title: `修改修课记录：${v.name}`,
      fields: [
        { key: 'sem', label: '学期（如 2025-2026-2；跨学年实践可写 2024-2028）', value: v.sem },
        { key: 'name', label: '课程名称', value: v.name, required: true },
        { key: 'credit', label: '学分', value: v.credit, placeholder: '如 2' },
        { key: 'cat', label: '课程类别（学分归属，按课程类别计入培养方案）', type: 'select', options: catOptions(), value: v.cat },
        { key: 'score', label: '成绩（留空表示在修）', value: v.score },
        {
          key: 'count_gp', label: '是否计入平均学分绩点（成绩留空时自动不计入）', type: 'select', value: v.count_gp,
          options: [{ value: 'auto', text: '自动判定（MOOC/智慧树、体育、国际课程等不计）' }, { value: 'true', text: '计入' }, { value: 'false', text: '不计入' }],
        },
      ],
      submitText: '保存',
      onSubmit: (vv) => saveRow(vv, s.score_id),
    })
  }

  function addOne() {
    openModal({
      title: '手动添加一门课程',
      fields: [
        { key: 'sem', label: '学期（如 2025-2026-2；跨学年实践可写 2024-2028）', value: '', placeholder: '2025-2026-2' },
        { key: 'name', label: '课程名称', value: '', required: true },
        { key: 'credit', label: '学分', value: '', placeholder: '如 2' },
        { key: 'cat', label: '课程类别（学分归属）', type: 'select', options: catOptions(), value: '' },
        { key: 'score', label: '成绩（留空表示在修）', value: '' },
        {
          key: 'count_gp', label: '是否计入平均学分绩点（成绩留空时自动不计入）', type: 'select', value: 'auto',
          options: [{ value: 'auto', text: '自动判定（MOOC/智慧树、体育、国际课程等不计）' }, { value: 'true', text: '计入' }, { value: 'false', text: '不计入' }],
        },
      ],
      submitText: '添加',
      onSubmit: (vv) => saveRow(vv, null),
    })
  }

  async function saveRow(v, scoreId) {
    await guard(async () => {
      const cat = v.cat
      if (!cat) throw new Error('请选择课程类别（学分归属）')
      const countGp = v.count_gp === 'auto' ? autoCountGp(v.name, cat, v.score) : v.count_gp === 'true'
      await dbRpc('save_student_score', {
        p_row: {
          score_id: scoreId || '',
          sem: v.sem, name: v.name, credit: v.credit, cat,
          nature: '必修', score: v.score, count_gp: countGp,
        },
      })
      closeModal()
      toast(scoreId ? '已保存修改' : '已添加，进度与建议已重算', 'ok')
      planCache = null   /* 改类别可能新建自动建档条目，旧快照里没有 → 强制重建，否则页面按同名匹配回原类目 */
      goto('myScores')
    })
  }

  function delRow(s) {
    openModal({
      title: `删除「${s.course?.course_name || '这条记录'}」？`,
      fields: [],
      submitText: '确认删除',
      onSubmit: async () => {
        await guard(async () => {
          await dbRpc('delete_student_score', { p_score_id: s.score_id })
          closeModal()
          toast('已删除该条记录', 'ok')
          goto('myScores')
        })
      },
    })
  }

  /* ---- 批量改绩点开关：在修（没成绩）的记录本就无法计入，由后端自动跳过 ---- */
  async function batchGp(next) {
    const ids = [...selIds]
    if (!ids.length) return
    const rows = mine.filter(s => ids.includes(String(s.score_id)))
    const doing = rows.filter(s => s.total_score === null || s.total_score === undefined).length
    await guard(async () => {
      const res = await dbRpc('batch_update_score_gp', { p_ids: ids, p_count_gp: next })
      const n = res && res.updated !== undefined ? res.updated : (rows.length - doing)
      toast(`已把 ${n} 条改为「${next ? '计入' : '不计入'}绩点」` +
        (doing ? ` · 另有 ${doing} 条在修（还没成绩）自动跳过，出分后系统会判定` : ''), 'ok')
      goto('myScores')
    })
  }

  /* ---- 批量删除：确认框里列出要删的课程，避免误删 ---- */
  function batchDel() {
    const ids = [...selIds]
    if (!ids.length) return
    const names = mine.filter(s => ids.includes(String(s.score_id)))
      .map(s => `· ${s.arrangement?.semester || '—'} ${s.course?.course_name || '—'}`)
    const show = names.slice(0, 15).join('\n') + (names.length > 15 ? `\n… 等共 ${names.length} 条` : '')
    openModal({
      title: `删除选中的 ${ids.length} 条修课记录？`,
      note: '删除后这几条记录不再计入任何进度与建议，需重新导入才能恢复。\n' + show,
      fields: [],
      submitText: '确认删除',
      onSubmit: async () => {
        await guard(async () => {
          const res = await dbRpc('batch_delete_scores', { p_ids: ids })
          closeModal()
          toast(`已删除 ${res && res.deleted !== undefined ? res.deleted : ids.length} 条记录`, 'ok')
          goto('myScores')
        })
      },
    })
  }

  function exportMine() {
    downloadXLSX('我的成绩单.xlsx', [{
      name: '我的成绩单',
      rows: [['学期', '课程名称', '学分', '总评', '绩点', '计入绩点', '状态', '学分归属'],
        ...mine.map(s => {
          const pc = plan.byCode[s.course?.plan_code || s.course?.course_id] || matchPlanCourse(plan, s.course?.course_name, s.course?.credit)
          return [s.arrangement?.semester, s.course?.course_name, s.course?.credit, s.total_score, s.gp,
            s.count_gp === false ? '不计入' : '计入', s.status, pc ? catPath(plan, pc.category_code) : '方案外']
        })],
      cols: [13, 32, 7, 7, 7, 9, 8, 30],
    }])
  }

  /* 无绩点模式：分数一律不读。成绩单（已结业）整份按「已完成」认定；课表按在修；
     Excel 里有分数的行视为已完成。入库的只有课程/学分/完成状态，没有分数与绩点 */
  function applyPrivacy(rows, mode) {
    for (const r of rows) {
      const had = r.score !== '' && r.score !== null && r.score !== undefined
      r.score = ''
      r.countGp = false
      if (mode === 'done' || (mode === 'excel' && had)) r.state = '完成'
      r.privacy = true
    }
  }

  /* 多文件导入（成绩单 + 课表一次选完）：逐个解析后合并，同名同学期的课去重（有成绩的优先） */
  async function onFile(e) {
    const files = [...(e.target.files || [])]
    e.target.value = ''
    if (!files.length) return
    await guard(async () => {
      const lists = []
      const noGpNames = []
      const labels = []
      const priv = !!state.privacyMode
      for (const file of files) {
        if (/\.pdf$/i.test(file.name || '')) {
          const { kind, recs } = await readPdfRecs(file)
          if (!recs.length) throw new Error(`「${file.name}」里没读到课程记录：可能是扫描件（图片型 PDF），请改用 Excel 或换文字版 PDF`)
          labels.push(kind === 'transcript' ? '成绩单' : '课表')
          for (const x of recs) if (x.noGp) noGpNames.push(normName(x.name))
          const rows = parseCourseRows(plan, pdfRecsToRows(recs))
          if (priv) applyPrivacy(rows, kind === 'transcript' ? 'done' : 'doing')
          lists.push(rows)
        } else {
          labels.push('表格')
          const rows = parseCourseRows(plan, await readTableRows(file))
          if (priv) applyPrivacy(rows, 'excel')
          lists.push(rows)
        }
      }
      const seen = new Map()
      const hasScore = (r) => r.score !== '' && r.score !== null && r.score !== undefined
      for (const r of lists.flat()) {
        const key = normName(r.name) + '|' + r.sem
        const old = seen.get(key)
        /* 无绩点模式下「已完成」的行优先于「在修」的行（成绩单+课表一起传时以成绩单为准） */
        if (!old || (!hasScore(old) && hasScore(r)) || (old.state !== '完成' && r.state === '完成')) seen.set(key, r)
      }
      const list = [...seen.values()]
      if (!list.length) throw new Error('未解析到有效数据行：表头需含「课程名称」（推荐 学期 / 课程名称 / 学分 / 课程类别 / 成绩）')
      /* 成绩单上的「#」是学校标注的不计入 GPA 课程，以它为准 */
      if (noGpNames.length) {
        for (const r of list) {
          if (noGpNames.indexOf(normName(r.name)) >= 0) { r.countGp = false; r.countGpAuto = false }
        }
      }
      renderPreview(list)
      state.importDraft = list   // 存草稿：切页后回来不用重新选文件
      const kindLabel = [...new Set(labels)].join(' + ')
      toast(`已识别${kindLabel}（${files.length} 个文件）：共 ${list.length} 门课程，请核对后导入`, 'ok')
    })
  }

  /* 预览表每次改动（切换绩点、改学分归属）都会整块重绘，保持滚动位置不跳顶 */
  function renderPreview(list) { keepScroll(() => drawPreview(list)) }

  function drawPreview(list) {
    result.innerHTML = ''
    const leafNames = leafCatNames(plan)
    let bad = 0, unconfirmed = 0, noGp = 0
    const needCf = (r) => !r.matched && !r.confirmed
    for (const r of list) {
      const errs = []
      if (!/^\d{4}-\d{4}(-[12])?$/.test(r.sem)) errs.push('学期')
      if (!(Number(r.credit) >= 0.5 && Number(r.credit) <= 20)) errs.push('学分')
      if (r.score !== '' && !(Number(r.score) >= 0 && Number(r.score) <= 100)) errs.push('成绩')
      if (!r.stateOk) errs.push('状态')
      if (!leafNames.includes(r.cat)) errs.push('归属')
      if (errs.length) bad++
      if (needCf(r)) unconfirmed++
      if (!r.countGp) noGp++
    }
    /* 待确认的行排最前面（稳定排序，同组内保持文件原顺序），一眼看完需要点的事 */
    const sorted = [...list].sort((a, b) => (needCf(a) ? 0 : 1) - (needCf(b) ? 0 : 1))
    const tbl = h('table', { class: 'tbl' })
    tbl.append(h('tr', {}, ...['学期', '课程名称', '学分', '成绩', '学分归属', '绩点', '匹配', '校验'].map(x => h('th', {}, x))))
    for (const r of sorted) {
      const errs = []
      if (!/^\d{4}-\d{4}(-[12])?$/.test(r.sem)) errs.push('学期')
      if (!(Number(r.credit) >= 0.5 && Number(r.credit) <= 20)) errs.push('学分')
      if (r.score !== '' && !(Number(r.score) >= 0 && Number(r.score) <= 100)) errs.push('成绩')
      if (!r.stateOk) errs.push('状态')
      if (!leafNames.includes(r.cat)) errs.push('归属')

      const sel = h('select', {})
      sel.append(h('option', { value: '' }, '— 请选择 —'))
      /* 推荐项排最前面但**不预选**：方案里没定死的课（体育A/B、通识任选、开放性选修）由用户拍板，
         点一下推荐项就等于确认；不想用推荐值，直接选别的类目 */
      if (r.catGuess && leafNames.includes(r.catGuess)) {
        sel.append(h('option', { value: r.catGuess }, `${r.catGuess}（推荐 · 按性质）`))
      }
      for (const n of leafNames) if (n !== (r.catGuess || '')) sel.append(h('option', { value: n }, n))
      sel.value = leafNames.includes(r.cat) ? r.cat : ''
      sel.addEventListener('change', () => {
        r.cat = sel.value
        r.catEdit = false   /* 改完自动收起下拉框，恢复成「文本 + 修改」的安静形态 */
        if (sel.value) r.confirmed = true   /* 自己选过 = 已确认，不再要求点第二下 */
        if (r.countGpAuto) r.countGp = autoCountGp(r.name, r.cat, r.score)
        renderPreview(list)
      })
      if (r.catAuto) sel.className = 'sel-auto'
      if (r.catGuess && !r.cat) sel.title = `培养方案里没有这个课名${r.natureRaw ? `，按课程性质「${r.natureRaw}」推荐「${r.catGuess}」` : ''}，请确认或改选`
      if (r.catIn && !leafNames.includes(r.cat)) sel.title = `表内填写的类别「${r.catIn}」未能对上培养方案分类，请手动选择`

      const catOk = leafNames.includes(r.cat)
      const matchTag = r.matched
        ? (r.fuzzy
            ? h('span', {
                class: 'tag orange',
                title: `文件里是「${r.name}」，培养方案里是「${r.planName}」，只差个别字眼（如「语言」），已按方案「${r.cat}」自动归属；若认为不是同一门课，请点右侧「修改」另选类别`,
              }, '已匹配 · 名称近似')
            : h('span', { class: 'tag green', title: `匹配到方案课程「${r.planName}」` }, '已匹配'))
        : (r.sameName && catOk
            ? h('span', {
                class: 'tag orange',
                title: `培养方案里有一门同名课（属于「${r.sameNameCat}」），与你填的类别不同 —— 只是巧合同名，不是同一门课；本行将按你填的「${r.cat}」计入`,
              }, '同名他课 · 按类别')
            : (catOk ? h('span', { class: 'tag orange', title: '培养方案里没有这门课，将按你选的「课程类别」计入' }, '按类别')
              : (r.catGuess
                  ? h('span', {
                      class: 'tag orange',
                      title: `培养方案里没有这个课名${r.natureRaw ? `，性质「${r.natureRaw}」大致可归入「${r.catGuess}」` : ''} —— 请在「学分归属」里点一下确认，或改选别的类目`,
                    }, '待选归属')
                  : h('span', { class: 'tag red' }, '方案外'))))

      /* 绩点：点一下即可切换计入 / 不计入（默认按规定自动判定）；没写成绩的课不计入；
         三门认定型实践课永远不出分，标「无需成绩」而不是「待出分」 */
      const noScoreYet = r.score === '' || r.score === null || r.score === undefined
      const gpTag = noScoreYet
        ? (isPracticeCourse(r.name)
            ? h('span', { class: 'tag gray', style: 'cursor:default', title: '认定型实践课不打分：状态「完成」即认定学分，不计入平均学分绩点' }, '无需成绩')
            : h('span', { class: 'tag gray', style: 'cursor:default', title: '还没成绩（在修），导入后不会计入平均学分绩点；出分后可在「我的课程」里调整' }, '待出分'))
        : h('span', {
            class: 'tag ' + (r.countGp ? 'green' : 'gray'),
            style: 'cursor:pointer',
            title: '点击切换：计入 / 不计入平均学分绩点',
            onclick: () => { r.countGp = !r.countGp; r.countGpAuto = false; renderPreview(list) },
          }, r.countGp ? '计入' : '不计入')

      /* 校验：课名不在培养方案里只是「待确认」，点一下确认即可（不阻塞导入） */
      let checkCell
      if (errs.length) checkCell = h('span', { class: 'tag red' }, '缺 ' + errs.join('、'))
      else if (!r.matched && !r.confirmed) {
        checkCell = h('span', {
          class: 'tag yellow', style: 'cursor:pointer',
          title: r.sameName
            ? `培养方案里的同名课属于「${r.sameNameCat}」，和你填的「${r.cat}」不是一回事；确认按你填的类别计入后点一下`
            : '培养方案原文里没有这个课名（可能只是示例或别人导入过的课），确认无误后按课程类别计入',
          onclick: () => { r.confirmed = true; renderPreview(list) },
        }, r.sameName ? '类别待确认 · 点击确认' : '课名待确认 · 点击确认')
      } else {
        checkCell = h('span', { class: 'tag green' }, '可导入')
      }

      /* 学分归属：已选定就显示文本，旁边留一个「修改」——点一下换回下拉框，选错了随时能改 */
      const catCell = catOk && !r.catEdit
        ? h('span', { style: 'white-space:nowrap' },
            h('span', { class: 'muted' }, r.cat), ' ',
            h('span', {
              class: 'tag gray', style: 'cursor:pointer',
              title: '选错了？点这里重新选择学分归属',
              onclick: () => { r.catEdit = true; renderPreview(list) },
            }, '修改'))
        : sel

      tbl.append(h('tr', { class: errs.length ? 'row-gap' : '' },
        h('td', {}, r.sem), h('td', {}, r.name), h('td', {}, r.credit),
        h('td', {}, r.score === ''
          ? (r.state === '完成' ? '（已完成·不计分）' : '（在修）')
          : r.score),
        h('td', {}, catCell),
        h('td', {}, gpTag),
        h('td', {}, matchTag),
        h('td', {}, checkCell),
      ))
    }
    const head = h('h3', {}, `解析结果：共 ${list.length} 条${bad ? `，其中 ${bad} 条需要修正（标红）` : '，全部可导入'}`)
    const card = h('div', { class: 'card', style: 'margin-top:14px' },
      head,
      h('p', { class: 'muted', style: 'margin:2px 0 10px' },
        `需要确认的课程已排在最前面（${unconfirmed} 门待确认）。培养方案里课名定死的课已自动归属；` +
        `体育A/B/C/D、通识任选、开放性选修这类方案里没有固定课名的，类别留空，请在「学分归属」里自己选 —— ` +
        `下拉框第一项是按课程性质给的推荐值，点一下即算确认；想省事就点「一键采用推荐归属并确认」。` +
        `不计入平均学分绩点的共 ${noGp} 门（MOOC/智慧树、体育课、国际课程、创新创业实践、大学生创新创业基础、大学生心理素质拓展，以及没写成绩的），点「绩点」列可逐条切换。`),
      unconfirmed > 0
        ? h('div', { style: 'margin:2px 0 10px' },
            h('button', {
              class: 'btn',
              /* 批量确认时顺带采用推荐归属 —— 否则只点确认、类别还空着，导入时照样会被跳过 */
              onclick: () => {
                for (const r of list) {
                  if (r.matched) continue
                  if (!r.cat && r.catGuess) r.cat = r.catGuess
                  if (r.countGpAuto) r.countGp = autoCountGp(r.name, r.cat, r.score)
                  r.confirmed = true
                }
                renderPreview(list)
              },
            }, `一键采用推荐归属并确认（${unconfirmed} 门）`))
        : null,
      tbl,
      h('div', { style: 'margin-top:12px' },
        h('button', { class: 'btn primary', onclick: doImport }, `确认导入 ${list.length} 条`)),
    )
    result.append(card)
    result._list = list
  }

  async function doImport() {
    await guard(async () => {
      const list = result._list || []
      const leafNames = leafCatNames(plan)
      const rows = []
      for (const r of list) {
        if (!leafNames.includes(r.cat)) { toast(`「${r.name}」没有选择学分归属，已跳过`, 'err'); continue }
        rows.push({ sem: r.sem, name: r.name, credit: r.credit, cat: r.cat, nature: r.nature || '必修', score: r.score, count_gp: r.countGp !== false,
          /* 模板「状态」列写「完成」= 学分已认定完成（成绩栏留空、分数不入库）：
             认定型实践课、无绩点模式的已结业课都走这条路 */
          state: r.state === '完成' ? '完成' : '' })
      }
      if (!rows.length) throw new Error('没有可导入的数据行')
      const res = await dbRpc('import_student_courses', { p_rows: rows })
      state.importDraft = null   // 已入库，草稿清掉
      const errs = res?.errors || []
      if ((res?.ok || 0) > 0 && !errs.length) {
        /* 全部成功：整页重渲染 —— 统计卡、课程列表、各页进度立即反映新数据。
           原来只更新导入区的成功卡片，页面其余部分还是进页时拉的旧数据，
           看起来就像「导入之后内容没有更新出来」 */
        planCache = null   /* 导入会新建自动建档条目，旧快照里没有 → 强制重建 */
        goto('myScores')
        toast(`已导入 ${res.ok} 条记录，页面已更新`, 'ok')
        askPracticeStatus()
      } else {
        /* 有失败（或一条都没进）：保留明细卡片让用户看清失败原因，点按钮跳转后即见新数据 */
        keepScroll(() => {
          result.innerHTML = ''
          result.append(h('div', { class: 'card', style: `border:1px solid ${errs.length ? '#c8871a' : 'var(--c-primary)'}` },
            h('h3', {}, errs.length ? `导入完成：成功 ${res?.ok || 0} 条，失败 ${errs.length} 条` : '没有记录导入成功'),
            ...errs.map(m => h('p', { style: 'color:var(--c-red);margin:4px 0' }, m)),
            h('div', { class: 'toolbar', style: 'margin-top:10px' },
              h('button', { class: 'btn primary', onclick: () => goto('myProgress') }, '看我的进度'),
              h('button', { class: 'btn', onclick: () => goto('myAdvice') }, '看选课建议'),
            ),
          ))
        })
        toast(errs.length ? `导入完成：成功 ${res?.ok || 0} 条，失败 ${errs.length} 条` : '没有记录导入成功，请检查数据后重试', 'err')
      }
    })
  }

  /* 三门认定型实践课（美育实践/志愿服务/社会实践）不打分，只认定完成与否。
     导入成功后若还有没记录的，弹窗让用户一次确认：已完成 = 认定 1 学分；未完成 = 先记为进行中。 */
  async function askPracticeStatus() {
    const PRAC = [
      { name: '美育实践', rule: '四年累计美育活动 ≥ 16 小时' },
      { name: '志愿服务', rule: '四年累计志愿服务 ≥ 20 小时' },
      { name: '社会实践', rule: '大二下学期结束后的暑假完成（2024 级即 2025-2026-2 后的暑假），一般大三上可确认' },
    ]
    let cur = []
    try { cur = await loadMyScores(ctx) } catch (e) { }
    const missing = PRAC.filter(p => !cur.some(s => normName(s.course?.course_name || '') === p.name))
    if (!missing.length) return
    openModal({
      title: '三门实践课，现在完成了吗？',
      note: '这三门课不打分，只按完成情况认定学分：\n'
        + missing.map(p => `· ${p.name}（1 学分）：${p.rule}`).join('\n')
        + '\n\n选「已完成」即认定该学分；选「未完成」会先记为「进行中」，完成后在「我的课程」里改成已完成即可。',
      fields: missing.map(p => ({
        key: p.name, label: `${p.name}（${p.rule}）`, type: 'select', value: 'no',
        options: [{ value: 'no', text: '未完成（还没做 / 没到时间）' }, { value: 'done', text: '已完成（达到要求）' }],
      })),
      submitText: '保存',
      onSubmit: async (vv) => {
        await guard(async () => {
          const rows2 = missing.map(p => ({
            sem: '2024-2028', name: p.name, credit: 1, cat: '公共实践', nature: '必修',
            score: '', count_gp: false, state: vv[p.name] === 'done' ? '完成' : '',
          }))
          const r2 = await dbRpc('import_student_courses', { p_rows: rows2 })
          closeModal()
          planCache = null
          const n2 = r2 && r2.ok !== undefined ? r2.ok : rows2.length
          toast(`实践课状态已记录（${n2} 条）`, 'ok')
          goto('myScores')
        })
      },
    })
  }
}

/* ============================================================
 * 启动
 * ============================================================ */
async function afterLogin() {
  const list = await dbSelect('user_profiles', { limit: 1 })
  const p = list[0] || null
  if (!p) {
    /* 只有登录记录、没有学籍档案（例如刚清过旧账号数据）——同样给他一条自助建档的路 */
    showBindPanel(null)
    return
  }
  if (p.role === 'admin') {
    /* 管理员是正式角色：不绑学号也能直接进系统（名册管理不需要学生身份） */
    state.profile = p
    enterApp()
    return
  }
  if (p.role !== 'student') {
    showBindPanel(p)
    return
  }
  state.profile = p
  enterApp()
}

/* 教师 / 其他非学生身份的旧账号：给一条「转成学生」的出路，而不是死路
   （管理员已升级为正式角色，在 afterLogin 里直接进系统，不会走到这里） */
let bindWired = false
function showBindPanel(p) {
  showView('loginView')
  authMsg('', false)
  for (const id of ['formPwd', 'formOtp', 'formForgot', 'linksLogin', 'linksOtp', 'linksForgot']) $(id).classList.add('hidden')
  const box = $('bindBox')
  box.classList.remove('hidden')
  const roleTxt = p ? (p.role === 'teacher' ? '教师' : p.role === 'admin' ? '管理员' : (p.role || '未知')) : ''
  $('bindSub').textContent = p
    ? `当前账号${p.real_name ? `「${p.real_name}」` : ''}是${roleTxt}身份，不是学生身份 —— 管理员请直接登录进入系统（侧栏有「名册管理」）。` +
      '如要以学生身份使用，填入你的学号和姓名即可转成学生并进入。'
    : '账号已创建！最后一步：填入你的学号和姓名，建立学生档案（学号需在本班名单内，且只能绑定一个账号）。绑定后就能导入成绩、查看查漏补缺了。'
  if (!bindWired) {
    bindWired = true
    $('btnBind').addEventListener('click', async () => {
      await guard(async () => {
        const sno = $('bindSno').value.trim()
        const name = $('bindName').value.trim()
        if (!/^\d{10,13}$/.test(sno)) return authMsg('请填写正确的学号（10–13 位数字）', false)
        if (!name) return authMsg('请填写姓名', false)
        /* 绑定失败是关键信息（学号被占 / 不在名册），用持久的 authMsg 而不是一闪而过的 toast */
        let rows
        try {
          rows = await dbRpc('register_identity', { p_role: 'student', p_real_name: name, p_identity: sno })
        } catch (err) {
          return authMsg('绑定失败：' + (err.message || '请重试'), false)
        }
        const np = Array.isArray(rows) ? rows[0] : rows
        if (!np || np.role !== 'student') throw new Error('绑定失败，请重试')
        state.profile = np
        box.classList.add('hidden')
        authMsg('绑定成功，正在进入…', true)
        enterApp()
      })
    })
    $('btnBindBack').addEventListener('click', async () => {
      /* 必须先登出再回登录页：只 reload 会被「已登录自动进绑定面板」弹回来（点不动 = 死循环） */
      try { await cloud.auth.signOut() } catch (e) { /* 登出失败也照常回登录页 */ }
      state.profile = null
      state.cache = {}
      planCache = null
      state.importDraft = null
      box.classList.add('hidden')
      showView('loginView')
      showAuthView('login')
    })
  }
}

/* ============================================================
 * 页面：名册管理（仅管理员）
 * 成绩由学生自己导入；管理员只负责名单 —— Excel 批量导入/更新名册，
 * 学生注册后凭学号绑定身份（先到先得、姓名以名册为准）。
 * ============================================================ */
PAGES.adminRoster = async (main) => {
  main.append(h('div', { class: 'page-title' }, '名册管理'))
  if (state.profile?.role !== 'admin') {
    main.append(h('p', { class: 'page-sub muted' }, '这个页面只有管理员能用。'))
    return
  }
  main.append(h('p', { class: 'page-sub' },
    '学生注册后凭学号绑定身份（学号唯一、先到先得，姓名一律以名册为准）；成绩由学生自己从教务导出件导入，这里只管名单。'))

  let roster = []
  try { roster = await dbRpc('admin_roster') } catch (e) { /* 非管理员或函数未建：给出可读提示 */ }
  if (!roster.length && state.profile?.role === 'admin') {
    main.append(h('div', { class: 'card' }, h('div', { class: 'empty' }, '名册读取失败或为空 —— 请确认已在数据库把你设为管理员（user_profiles.role = admin）')))
    return
  }

  const bound = roster.filter(s => s.bound).length
  main.append(h('div', { class: 'toolbar', style: 'margin:8px 0 14px' },
    h('span', { class: 'tag blue' }, `名册 ${roster.length} 人`),
    h('span', { class: 'tag green' }, `已注册绑定 ${bound}`),
    h('span', { class: 'tag gray' }, `未注册 ${roster.length - bound}`)))

  /* ---- 批量导入卡片 ---- */
  const importCard = h('div', { class: 'card' })
  importCard.append(h('h3', {}, '批量导入 / 更新名册'))
  importCard.append(h('p', { class: 'muted', style: 'line-height:1.9' },
    'Excel（.xlsx/.xls）或 CSV，第一行表头，需要「学号」「姓名」两列，班级 / 专业 / 性别 / 入学年份可选。',
    h('br'), '学号已存在的行会更新姓名等信息（覆盖式），新学号新增；入学年份缺省按学号前 4 位推算。'))
  const toolRow = h('div', { class: 'toolbar', style: 'margin:12px 0 0' })
  const fileInput = h('input', { type: 'file', accept: '.xlsx,.xls,.xlsm,.csv', style: 'display:none' })
  toolRow.append(
    h('button', { class: 'btn', onclick: () => downloadXLSX('学生名册导入模板.xlsx', [
      { name: '名册导入', rows: [
        ['学号', '姓名', '班级', '专业', '性别', '入学年份'],
        ['2025315220999', '张三', '计科2501', '计算机科学与技术', '男', '2025'],
      ], cols: [16, 10, 12, 20, 8, 10] },
    ]) }, '下载导入模板'),
    h('button', { class: 'btn primary', onclick: () => fileInput.click() }, '选择名单文件'),
    fileInput,
  )
  importCard.append(toolRow)

  const colOf = (header, keys) => header.findIndex(cell => keys.some(k => String(cell || '').includes(k)))
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0]
    fileInput.value = ''
    if (!file) return
    await guard(async () => {
      const grid = await readTableRows(file)
      if (!grid.length) throw new Error('文件是空的')
      const header = grid[0]
      const iSid = colOf(header, ['学号'])
      const iName = colOf(header, ['姓名'])
      if (iSid < 0 || iName < 0) throw new Error('表头里没找到「学号」和「姓名」列 —— 请按模板整理后重试')
      const iCls = colOf(header, ['班级'])
      const iMaj = colOf(header, ['专业'])
      const iGen = colOf(header, ['性别'])
      const iEy = colOf(header, ['入学', '年级'])
      const rows = [], bad = []
      const known = new Set(roster.map(s => s.student_id))
      for (let i = 1; i < grid.length; i++) {
        const r = grid[i]
        const sid = String(r[iSid] || '').replace(/\s/g, '')
        const name = String(r[iName] || '').trim()
        if (!sid && !name) continue
        if (!/^\d{6,14}$/.test(sid) || !name) { bad.push({ line: i + 1, sid, name }); continue }
        rows.push({
          student_id: sid, name,
          class_name: iCls >= 0 ? String(r[iCls] || '').trim() : '',
          major_name: iMaj >= 0 ? String(r[iMaj] || '').trim() : '',
          gender: iGen >= 0 ? String(r[iGen] || '').trim() : '',
          enroll_year: iEy >= 0 && /^\d{4}$/.test(String(r[iEy] || '').trim()) ? String(r[iEy]).trim() : '',
          isNew: !known.has(sid),
        })
      }
      if (!rows.length && !bad.length) throw new Error('没解析出有效的学生行')
      drawPreview(rows, bad, file.name)
    })
  })

  const previewBox = h('div')
  importCard.append(previewBox)
  function drawPreview(rows, bad, fname) {
    previewBox.innerHTML = ''
    const nNew = rows.filter(r => r.isNew).length
    const head = h('div', { class: 'toolbar', style: 'margin:14px 0 0' },
      h('span', { class: 'tag blue' }, `解析成功 ${rows.length} 行`),
      h('span', { class: 'tag green' }, `新增 ${nNew}`),
      h('span', { class: 'tag yellow' }, `更新 ${rows.length - nNew}`),
      bad.length ? h('span', { class: 'tag red' }, `无效 ${bad.length} 行（缺学号/姓名或学号不是数字）`) : null,
    )
    previewBox.append(head)
    if (bad.length) {
      previewBox.append(h('p', { class: 'muted', style: 'font-size:12px' },
        '无效行：' + bad.slice(0, 5).map(b => `第${b.line}行(${b.sid || '无学号'} ${b.name || '无姓名'})`).join('、') + (bad.length > 5 ? ' …' : '')))
    }
    const tbl = h('table', { class: 'tbl' })
    tbl.append(h('tr', {}, ...['学号', '姓名', '班级', '专业', '入学', '动作'].map(x => h('th', {}, x))))
    const known = new Set(roster.map(s => s.student_id))
    for (const r of rows.slice(0, 8)) {
      tbl.append(h('tr', {},
        h('td', {}, r.student_id), h('td', {}, r.name),
        h('td', {}, r.class_name || '—'), h('td', {}, r.major_name || '—'),
        h('td', {}, r.enroll_year || '（按学号推算）'),
        h('td', {}, h('span', { class: 'tag ' + (r.isNew ? 'green' : 'yellow') }, r.isNew ? '新增' : '更新')),
      ))
    }
    previewBox.append(tbl)
    if (rows.length > 8) previewBox.append(h('p', { class: 'muted', style: 'font-size:12px' }, `仅预览前 8 行，共 ${rows.length} 行（来自 ${fname}）`))
    previewBox.append(h('div', { class: 'toolbar', style: 'margin-top:12px' },
      h('button', {
        class: 'btn primary',
        onclick: async () => {
          await guard(async () => {
            const payload = rows.map(({ isNew, ...rest }) => rest)
            const res = await dbRpc('admin_import_students', { p_rows: payload })
            const r = Array.isArray(res) ? res[0] : res
            const errs = (r && r.errors) || []
            toast(`导入完成：新增 ${r.inserted}，更新 ${r.updated}${r.skipped ? `，跳过 ${r.skipped}` : ''}${errs.length ? `，失败 ${errs.length}` : ''}`, errs.length ? 'err' : 'ok')
            goto('adminRoster')
          })
        },
      }, `确认导入 ${rows.length} 行`),
      h('button', { class: 'btn', onclick: () => { previewBox.innerHTML = '' } }, '取消'),
    ))
  }
  main.append(importCard)

  /* ---- 名册列表（可搜索） ---- */
  const listCard = h('div', { class: 'card' })
  listCard.append(h('h3', {}, '名册列表'))
  const q = h('input', { type: 'text', placeholder: '搜索学号 / 姓名 / 班级…', style: 'max-width:260px' })
  const listBox = h('div', { style: 'margin-top:10px; overflow-x:auto' })
  listCard.append(h('div', { class: 'toolbar' }, q), listBox)
  function drawList() {
    const kw = q.value.trim().toLowerCase()
    const rows = kw
      ? roster.filter(s => [s.student_id, s.name, s.class_name, s.major_name].some(v => String(v || '').toLowerCase().includes(kw)))
      : roster
    listBox.innerHTML = ''
    if (!rows.length) { listBox.append(h('div', { class: 'empty' }, '没有匹配的学生')); return }
    const tbl = h('table', { class: 'tbl' })
    tbl.append(h('tr', {}, ...['学号', '姓名', '班级', '专业', '入学', '注册状态'].map(x => h('th', {}, x))))
    for (const s of rows) {
      tbl.append(h('tr', {},
        h('td', {}, s.student_id), h('td', {}, s.name),
        h('td', {}, s.class_name || '—'), h('td', {}, s.major_name || '—'),
        h('td', {}, s.enroll_year || '—'),
        h('td', {}, h('span', { class: 'tag ' + (s.bound ? 'green' : 'gray') }, s.bound ? '已注册' : '未注册')),
      ))
    }
    listBox.append(tbl)
    if (rows.length > 100) listBox.append(h('p', { class: 'muted', style: 'font-size:12px' }, `共 ${rows.length} 人`))
  }
  q.addEventListener('input', drawList)
  drawList()
  main.append(listCard)
  main.append(h('p', { class: 'muted', style: 'font-size:12px; margin-top:10px' },
    '提示：名册里的「专业」决定同学登录后加载哪份培养方案（信息管理与信息系统 / 工程管理 / 土地资源管理 / 行政管理 → 各自的 2023 版方案；其他专业走默认信管方案）。导入时请把专业列填对。'))
}

/* ============================================================
 * 页面：账号管理（仅管理员）
 * 列出所有注册账号（登录账号 + 绑定学号 + 角色），可切换角色（student/admin）。
 * 管理员可以提拔普通同学为管理员、或把某账号降回学生；不能改自己、不能降级最后一个管理员。
 * ============================================================ */
PAGES.adminUsers = async (main) => {
  main.append(h('div', { class: 'page-title' }, '账号管理'))
  if (state.profile?.role !== 'admin') {
    main.append(h('p', { class: 'page-sub muted' }, '这个页面只有管理员能用。'))
    return
  }
  main.append(h('p', { class: 'page-sub' },
    '查看所有注册账号，可把某账号设为「管理员」或降回「学生」。纯管理员登录后只看到后台管理入口，看不到任何同学的学业与成绩。'))

  let data = null
  try { data = await dbRpc('admin_users') } catch (e) { data = null }
  const me = data && data.me
  const rows = (data && data.rows) || []

  const cntAdmin = rows.filter(u => u.role === 'admin').length
  const cntStudent = rows.filter(u => u.role === 'student').length
  const cntUnbound = rows.filter(u => u.role === 'student' && !u.student_id).length
  main.append(h('div', { class: 'toolbar', style: 'margin:8px 0 14px' },
    h('span', { class: 'tag blue' }, `注册账号 ${rows.length}`),
    h('span', { class: 'tag yellow' }, `管理员 ${cntAdmin}`),
    h('span', { class: 'tag green' }, `学生 ${cntStudent}`),
    h('span', { class: 'tag gray' }, `未绑学号 ${cntUnbound}`)))

  const card = h('div', { class: 'card' })
  const q = h('input', { type: 'text', placeholder: '搜索账号 / 学号 / 姓名…', style: 'max-width:280px' })
  const box = h('div', { style: 'margin-top:10px; overflow-x:auto' })
  card.append(h('div', { class: 'toolbar' }, q), box)

  const roleLabel = r => r === 'admin' ? '管理员' : '学生'
  function drawList() {
    const kw = q.value.trim().toLowerCase()
    const list = kw
      ? rows.filter(u => [u.email, u.phone, u.student_id, u.real_name].some(v => String(v || '').toLowerCase().includes(kw)))
      : rows
    box.innerHTML = ''
    if (!list.length) { box.append(h('div', { class: 'empty' }, '没有匹配的账号')); return }
    const tbl = h('table', { class: 'tbl' })
    tbl.append(h('tr', {}, ...['登录账号', '姓名', '学号', '角色', '注册时间', '操作'].map(x => h('th', {}, x))))
    for (const u of list) {
      const isMe = u.id === me
      const isLastAdmin = u.role === 'admin' && cntAdmin <= 1
      let opCell
      if (isMe) {
        opCell = h('td', {}, h('span', { class: 'tag gray' }, '当前账号'))
      } else if (u.role === 'admin') {
        opCell = h('td', {}, isLastAdmin
          ? h('span', { class: 'tag gray' }, '唯一管理员')
          : h('button', { class: 'btn sm', onclick: () => setRole(u, 'student') }, '降为学生'))
      } else {
        opCell = h('td', {}, h('button', { class: 'btn sm primary', onclick: () => setRole(u, 'admin') }, '设为管理员'))
      }
      const acct = u.email || u.phone || u.id
      tbl.append(h('tr', {},
        h('td', {}, String(acct)),
        h('td', {}, u.real_name || '—'),
        h('td', {}, u.student_id || '—'),
        h('td', {}, h('span', { class: 'tag ' + (u.role === 'admin' ? 'yellow' : 'green') }, roleLabel(u.role))),
        h('td', {}, u.created_at ? String(u.created_at).slice(0, 16).replace('T', ' ') : '—'),
        opCell,
      ))
    }
    box.append(tbl)
    if (list.length > 100) box.append(h('p', { class: 'muted', style: 'font-size:12px' }, `共 ${list.length} 个账号`))
  }

  async function setRole(u, role) {
    await guard(async () => {
      const res = await dbRpc('admin_set_role', { p_user_id: u.id, p_role: role })
      const r = Array.isArray(res) ? res[0] : res
      if (!r || r.ok !== true) throw new Error((r && r.error) || '操作失败')
      toast(`已将「${u.real_name || u.email || u.id}」设为${role === 'admin' ? '管理员' : '学生'}`, 'ok')
      goto('adminUsers')
    }, `确认把「${u.real_name || u.email || u.id}」设为${role === 'admin' ? '管理员' : '学生'}？`)
  }

  q.addEventListener('input', drawList)
  drawList()
  main.append(card)
  main.append(h('p', { class: 'muted', style: 'font-size:12px; margin-top:10px' },
    '提示：设为管理员后，该账号登录即拥有「名册管理」「账号管理」两个后台入口（学生端页面照常可用）；纯管理员（未绑学号）则只显示后台入口。管理员无法被普通同学通过前端改名或改角色。'))
}

async function boot() {
  showView('loginView')
  const { data: session } = await cloud.auth.getSession()
  if (session) { try { await afterLogin() } catch (e) { showView('loginView') } }
  cloud.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') { state.profile = null; planCache = null; state.planMajor = ''; state.importDraft = null; showView('loginView') }
  })
}
