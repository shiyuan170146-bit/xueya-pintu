/* ============================================================
 * 学涯拼图 · 本机自建后端
 * 零框架（node:http）+ MySQL 8
 * 对外提供三组接口：
 *   /api/db/:table/:op   —— 表读写（select/insert/upsert/update/delete）
 *   /api/rpc/:fn         —— 业务过程（注册身份、导入选课、导入成绩、批量操作）
 *   /api/auth/*          —— 登录 / 注册 / 验证码 / 会话
 * 同时托管 web/ 下的静态页面
 * ============================================================ */
const http = require('http')
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const { URL } = require('url')

const { asUser, query } = require('./db')
const auth = require('./auth')

const PORT = Number(process.env.PORT || 8787)
const WEB_DIR = path.join(__dirname, '..', 'web')

/* ---------------- 表结构白名单（防注入 + 列名校验） ---------------- */
const TABLES = {
  plan_categories: ['code', 'name', 'parent_code', 'required_credits', 'note', 'sort'],
  plan_courses: ['code', 'name', 'credits', 'sem_from', 'sem_to', 'category_code', 'nature', 'is_generic', 'note'],
  students: ['student_id', 'name', 'gender', 'class_name', 'major_name', 'enroll_year', 'phone', 'status', 'created_at'],
  courses: ['course_id', 'course_name', 'credit', 'hours', 'nature', 'created_at', 'plan_code'],
  course_arrangements: ['arrange_id', 'course_id', 'class_name', 'semester', 'is_archived'],
  scores: ['score_id', 'student_id', 'arrange_id', 'usual_score', 'exam_score', 'total_score', 'gp', 'count_gp', 'status', 'is_archived', 'updated_at'],
  user_profiles: ['id', 'owner_id', 'real_name', 'role', 'student_id', 'phone', 'demo_mode', 'created_at', 'updated_at'],
  operation_logs: ['log_id', 'user_id', 'module', 'action', 'detail', 'ip', 'operate_time'],
}

/* 各表主键：写入后按主键回读整行 */
const PKS = {
  plan_categories: 'code', plan_courses: 'code', students: 'student_id', courses: 'course_id',
  course_arrangements: 'arrange_id', scores: 'score_id', user_profiles: 'id', operation_logs: 'log_id',
}

/* 写权限：表 -> 允许的角色 */
const WRITE_ROLES = {
  students: ['admin'], courses: ['admin'],
  course_arrangements: ['admin'], plan_categories: ['admin'], plan_courses: ['admin'],
  user_profiles: ['admin'],
  scores: ['admin', 'student'], operation_logs: ['admin', 'student'],
}

/* 仅本人可见的表：强制按 owner_id 过滤 */
const OWNER_ONLY = { user_profiles: 'owner_id' }

/* ---------------- HTTP 小工具 ---------------- */
function json(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (c) => { raw += c; if (raw.length > 20 * 1024 * 1024) reject(new Error('请求体过大')) })
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}) } catch (e) { reject(new Error('请求体不是合法 JSON')) } })
    req.on('error', reject)
  })
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.csv': 'text/csv; charset=utf-8',
}

/* gzip：文本类资源（js/css/html/json）压完通常只剩 1/4。
   3Mbps 小水管上这是最立竿见影的一条。
   压缩结果按「文件+大小+mtime」缓存，只在文件变更后重压一次。 */
const GZIP_TYPES = new Set(['.html', '.js', '.css', '.json', '.svg', '.csv', '.txt'])
const gzipCache = new Map()
function gzipBuf(file, buf) {
  let st = null
  try { st = fs.statSync(file) } catch (e) {}
  const key = file + ':' + buf.length + ':' + (st ? st.mtimeMs : 0)
  const hit = gzipCache.get(key)
  if (hit) return hit
  const z = zlib.gzipSync(buf, { level: 6 })
  if (gzipCache.size >= 128) gzipCache.clear()
  gzipCache.set(key, z)
  return z
}

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname)
  if (rel === '/' || rel === '') rel = '/index.html'
  const file = path.join(WEB_DIR, rel)
  if (!file.startsWith(WEB_DIR)) { res.writeHead(403); return res.end('forbidden') }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404 ' + rel) }
    /* index.html 用 no-store（保证发版即生效）；带版本号 query 的静态资源（app.js?v=…）
       可以放心长缓存 —— 改代码必升版本号，新版本 = 新 URL 不会命中旧缓存。
       3Mbps 小水管上这一条省掉绝大多数重复下载。 */
    const ext = path.extname(file).toLowerCase()
    const cacheable = rel !== '/index.html'
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': cacheable ? 'public, max-age=604800' : 'no-store',
      'Vary': 'Accept-Encoding',
    }
    const wantsGzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '')
    if (wantsGzip && GZIP_TYPES.has(ext) && buf.length > 1024) {
      const z = gzipBuf(file, buf)
      headers['Content-Encoding'] = 'gzip'
      headers['Content-Length'] = z.length
      res.writeHead(200, headers)
      return res.end(z)
    }
    headers['Content-Length'] = buf.length
    res.writeHead(200, headers)
    res.end(buf)
  })
}

/* ---------------- 登录态 ---------------- */
function currentAuth(req) {
  const h = req.headers['authorization'] || ''
  const m = /^Bearer\s+(.+)$/i.exec(h)
  if (!m) return null
  return auth.verifyTokenMeta(m[1])
}

function currentUser(req) {
  const me = currentAuth(req)
  return me ? me.uid : null
}

/* 令牌签名有效 ≠ 账号还在：users 行被删后（清库/删号），旧令牌必须当场作废，
   否则浏览器里残留的登录态会变成「幽灵会话」 */
async function liveUser(uid) {
  if (!uid) return false
  const r = await query('SELECT 1 FROM users WHERE id = ? LIMIT 1', [uid])
  return r.rows.length > 0
}

async function getProfile(uid) {
  const r = await query('SELECT * FROM user_profiles WHERE owner_id = ?', [uid])
  return r.rows[0] || null
}

/* ---------------- 表读写 ---------------- */
function ident(name) { return '`' + String(name).replace(/`/g, '``') + '`' }

function checkColumns(table, keys) {
  const allow = TABLES[table]
  return keys.filter((k) => allow.includes(k))
}

function buildWhere(table, filters, params) {
  const parts = []
  const allow = TABLES[table]
  for (const f of filters || []) {
    if (!allow.includes(f.col)) throw new Error('未知列：' + f.col)
    if (f.op === 'eq') { params.push(f.val); parts.push(`${ident(f.col)} = ?`) }
    else if (f.op === 'in') {
      const list = Array.isArray(f.val) ? f.val : [f.val]
      if (!list.length) { parts.push('1 = 0') }
      else { params.push(list); parts.push(`${ident(f.col)} IN (?)`) }
    } else throw new Error('不支持的比较符：' + f.op)
  }
  return parts.length ? ' WHERE ' + parts.join(' AND ') : ''
}

function buildOrderLimit(table, order, limit, range, params) {
  let sql = ''
  if (order && order.col) {
    if (!TABLES[table].includes(order.col)) throw new Error('未知排序列：' + order.col)
    sql += ` ORDER BY ${ident(order.col)} ${order.ascending === false ? 'DESC' : 'ASC'}`
  }
  let lim = null, off = 0
  if (Array.isArray(range) && range.length === 2) { off = Number(range[0]) || 0; lim = (Number(range[1]) - Number(range[0]) + 1) }
  else if (limit) lim = Number(limit)
  if (lim != null) { params.push(lim); sql += ' LIMIT ?' }
  if (off) { params.push(off); sql += ' OFFSET ?' }
  return sql
}

async function dbOp(uid, profile, table, op, body, isDemo) {
  if (!TABLES[table]) throw new Error('未知数据表：' + table)
  if (isDemo && op !== 'select') throw new Error('演示模式为只读，不能修改数据')
  const role = profile ? profile.role : null
  const isWrite = op !== 'select'
  if (isWrite) {
    const allowed = WRITE_ROLES[table] || []
    if (!role || !allowed.includes(role)) throw new Error('当前身份无权修改该数据（' + table + '）')
  }

  return asUser(uid, async (conn) => {
    if (op === 'select') {
      const params = []
      const filters = (body.filters || []).slice()
      const ownerCol = OWNER_ONLY[table]
      if (ownerCol) filters.push({ col: ownerCol, op: 'eq', val: uid })
      /* 行级归属强制：scores/students 按学号归属（本人只能读自己的行），其余为共享参考表 */
      const sid = profile && profile.student_id ? String(profile.student_id) : null
      if ((table === 'scores' || table === 'students')) {
        if (!sid) return []
        filters.push({ col: 'student_id', op: 'eq', val: sid })
      }
      const sql = `SELECT * FROM ${ident(table)}` + buildWhere(table, filters, params)
        + buildOrderLimit(table, body.order, body.limit, body.range, params)
      const [rows] = await conn.query(sql, params)
      return rows
    }

    if (op === 'insert' || op === 'upsert') {
      let rows = Array.isArray(body.rows) ? body.rows : [body.rows]
      rows = rows.map((row) => {
        const o = { ...row }
        if (table === 'operation_logs') o.user_id = uid
        if (table === 'user_profiles') o.owner_id = uid
        return o
      })
      /* scores 写入强制归属本人学号，防止越权写入他人成绩 */
      const mySid = profile && profile.student_id ? String(profile.student_id) : null
      if (table === 'scores') {
        if (!mySid) throw new Error('当前身份未绑定学号，不能写入成绩')
        rows = rows.map((row) => ({ ...row, student_id: mySid }))
      }
      const cols = [...new Set(rows.flatMap((r) => checkColumns(table, Object.keys(r))))]
      if (!cols.length) throw new Error('没有可写入的字段')
      const params = []
      const valuesSql = rows.map((r) => '(' + cols.map((c) => {
        if (!(c in r) || r[c] === undefined) return 'DEFAULT'
        params.push(r[c]); return '?'
      }).join(',') + ')').join(',')

      let sql = `INSERT INTO ${ident(table)} (${cols.map(ident).join(',')}) VALUES ${valuesSql}`
      if (op === 'upsert') {
        const conflict = String(body.onConflict || '').split(',').map((s) => s.trim()).filter(Boolean)
        const sets = (conflict.length ? cols.filter((c) => !conflict.includes(c)) : cols)
          .map((c) => `${ident(c)} = VALUES(${ident(c)})`)
        sql += sets.length ? ' ON DUPLICATE KEY UPDATE ' + sets.join(', ') : ' ON DUPLICATE KEY UPDATE ' + ident(PKS[table]) + ' = ' + ident(PKS[table])
      }

      const [res] = await conn.query(sql, params)

      /* 按主键回读刚写入的行（MySQL 无 RETURNING，等价于 INSERT ... RETURNING *） */
      const pk = PKS[table]
      const pkVals = rows.map((r) => r[pk]).filter((v) => v !== undefined && v !== null)
      if (pk && pkVals.length === rows.length) {
        const [sel] = await conn.query(`SELECT * FROM ${ident(table)} WHERE ${ident(pk)} IN (?)`, [pkVals])
        return sel
      }
      if (pk && res.insertId) {
        const [sel] = await conn.query(
          `SELECT * FROM ${ident(table)} WHERE ${ident(pk)} BETWEEN ? AND ? ORDER BY ${ident(pk)}`,
          [res.insertId, res.insertId + rows.length - 1]
        )
        return sel
      }
      return []
    }

    if (op === 'update') {
      const vals = {}
      for (const [k, v] of Object.entries(body.values || {})) {
        if (!TABLES[table].includes(k)) continue
        vals[k] = v
      }
      const keys = Object.keys(vals)
      if (!keys.length) throw new Error('没有可更新的字段')
      /* scores 更新强制限定本人学号的行 */
      const mySidU = profile && profile.student_id ? String(profile.student_id) : null
      if (table === 'scores') {
        if (!mySidU) throw new Error('当前身份未绑定学号')
        body.filters = (body.filters || []).concat([{ col: 'student_id', op: 'eq', val: mySidU }])
      }
      const whereParams = []
      const whereSql = buildWhere(table, body.filters, whereParams)
      if (!whereSql) throw new Error('更新操作必须带条件')

      const pk = PKS[table]
      const [pre] = await conn.query(`SELECT ${ident(pk)} AS pk FROM ${ident(table)}${whereSql}`, whereParams)
      const setParams = []
      const setSql = keys.map((k) => { setParams.push(vals[k]); return `${ident(k)} = ?` }).join(', ')
      await conn.query(`UPDATE ${ident(table)} SET ${setSql}${whereSql}`, setParams.concat(whereParams))

      const pks = pre.map((r) => r.pk)
      if (!pks.length) return []
      const [sel] = await conn.query(`SELECT * FROM ${ident(table)} WHERE ${ident(pk)} IN (?)`, [pks])
      return sel
    }

    if (op === 'delete') {
      /* scores 删除强制限定本人学号的行 */
      const mySidD = profile && profile.student_id ? String(profile.student_id) : null
      if (table === 'scores') {
        if (!mySidD) throw new Error('当前身份未绑定学号')
        body.filters = (body.filters || []).concat([{ col: 'student_id', op: 'eq', val: mySidD }])
      }
      const params = []
      const whereSql = buildWhere(table, body.filters, params)
      if (!whereSql) throw new Error('删除操作必须带条件')
      const [res] = await conn.query(`DELETE FROM ${ident(table)}${whereSql}`, params)
      return { deleted: res.affectedRows }
    }

    throw new Error('未知操作：' + op)
  })
}

/* ---------------- 业务过程（RPC） ---------------- */
/* 每个过程返回：
 *   proc —— 存储过程名
 *   args —— 入参（JSON 类型的参数统一用 JSON 字符串传入）
 *   json —— 过程以 JSON_OBJECT 形式返回结果（取首行 r 字段）
 */
const RPCS = {
  register_identity: (p) => ({
    proc: 'sp_register_identity',
    args: [p.p_role, p.p_real_name || '', p.p_identity || '', p.p_class_name || '', p.p_major_name || '', p.p_title || '', p.p_department || ''],
  }),
  import_student_courses: (p) => ({ proc: 'sp_import_student_courses', args: [JSON.stringify(p.p_rows || [])], json: true }),
  save_student_score: (p) => ({ proc: 'sp_save_student_score', args: [JSON.stringify(p.p_row || {})], json: true }),
  update_student_score: (p) => ({ proc: 'sp_update_student_score', args: [p.p_score_id, p.p_score, p.p_count_gp], json: true }),
  delete_student_score: (p) => ({ proc: 'sp_delete_student_score', args: [p.p_score_id], json: true }),
  batch_update_score_gp: (p) => ({ proc: 'sp_batch_update_score_gp', args: [JSON.stringify((p.p_ids || []).map(Number)), p.p_count_gp], json: true }),
  batch_delete_scores: (p) => ({ proc: 'sp_batch_delete_scores', args: [JSON.stringify((p.p_ids || []).map(Number))], json: true }),
}

/* 演示模式下禁止调用的写入类接口（读接口不受限；admin_* 由角色校验拦截） */
const WRITE_RPCS = new Set([
  'register_identity', 'import_student_courses', 'save_student_score',
  'update_student_score', 'delete_student_score', 'batch_update_score_gp',
  'batch_delete_scores', 'archive_arrangement',
])

async function runRpc(conn, proc, args) {
  const marks = args.map(() => '?').join(',')
  const [sets] = await conn.query(`CALL ${proc}(${marks})`, args)
  return Array.isArray(sets) && Array.isArray(sets[0]) ? sets[0] : []
}

/* ---------------- 路由 ---------------- */
async function handle(req, res) {
  const u = new URL(req.url, 'http://localhost')
  const p = u.pathname

  if (!p.startsWith('/api/')) return serveStatic(req, res, p)

  if (req.method !== 'POST' && req.method !== 'GET') return json(res, 405, { error: { message: '方法不支持' } })
  const body = req.method === 'POST' ? await readBody(req) : {}

  /* ---- 会话 ---- */
  if (p === '/api/auth/login' && req.method === 'POST') {
    /* 账号可以是邮箱，也可以是手机号（注册时统一设置了密码） */
    const user = await auth.findUser(body.email ? { email: body.email } : { phone: body.phone })
    if (!user || !auth.verifyPassword(body.password, user.pass_hash)) {
      return json(res, 200, { error: { message: '账号或密码错误' } })
    }
    return json(res, 200, { data: { session: { user: { id: user.id, email: user.email } }, token: auth.signToken(user.id) } })
  }

  if (p === '/api/auth/session') {
    const uid = currentUser(req)
    if (!uid || !(await liveUser(uid))) return json(res, 200, { data: { session: null } })
    const pr = await getProfile(uid)
    return json(res, 200, { data: { session: { user: { id: uid }, profile: pr } } })
  }

  if (p === '/api/auth/logout') return json(res, 200, { data: {} })

  /* 演示模式：免注册一键进入只读演示账号（供同学/老师/面试官参观，写入一律被拒）。
     演示学籍首次使用时复制一份吴胜男（2024315220127）的成绩作展示数据。 */
  if (p === '/api/auth/demo' && req.method === 'POST') {
    const DEMO_UID = 'u_demo_public'
    const DEMO_SID = '9900000000001'
    await query(
      `INSERT INTO users (id, email, pass_hash) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE email = VALUES(email)`,
      [DEMO_UID, 'demo@xueyapintu.local', '!demo-no-login'])
    await query(
      `INSERT INTO user_profiles (owner_id, real_name, role, student_id, demo_mode)
       VALUES (?, '演示同学', 'student', ?, 1)
       ON DUPLICATE KEY UPDATE role = 'student', student_id = VALUES(student_id), demo_mode = 1, real_name = VALUES(real_name)`,
      [DEMO_UID, DEMO_SID])
    await query(
      `INSERT INTO students (student_id, name, class_name, major_name, gender, enroll_year)
       VALUES (?, '演示同学', '信管2401', '信息管理与信息系统', '女', 2024)
       ON DUPLICATE KEY UPDATE name = VALUES(name), class_name = VALUES(class_name), major_name = VALUES(major_name)`,
      [DEMO_SID])
    const cnt = await query('SELECT COUNT(*) AS c FROM scores WHERE student_id = ?', [DEMO_SID])
    if (!(cnt.rows[0] && cnt.rows[0].c)) {
      await query(
        `INSERT INTO scores (student_id, arrange_id, usual_score, exam_score, total_score, gp, count_gp, status)
         SELECT ?, arrange_id, usual_score, exam_score, total_score, gp, count_gp, status
           FROM scores WHERE student_id = '2024315220127'`,
        [DEMO_SID])
    }
    const profile = await getProfile(DEMO_UID)
    return json(res, 200, { data: { session: { user: { id: DEMO_UID }, profile }, token: auth.signToken(DEMO_UID, { demo: true }) } })
  }

  if (p === '/api/auth/send-otp' && req.method === 'POST') {
    const target = body.email ? { email: body.email } : { phone: body.phone }
    if (!target.email && !target.phone) return json(res, 200, { error: { message: '请填写邮箱或手机号' } })
    let sent
    try {
      sent = await auth.sendOtp(target)
    } catch (err) {
      return json(res, 200, { error: { message: err.public ? err.message : '验证码发送失败，请稍后重试' } })
    }
    const existing = await auth.findUser(target)
    return json(res, 200, {
      data: { verificationId: sent.verificationId, isExistingUser: !!existing, devCode: sent.code || null, email: target.email || null, phone: target.phone || null },
    })
  }

  if (p === '/api/auth/verify-otp' && req.method === 'POST') {
    const target = body.email ? { email: body.email } : { phone: body.phone }
    const bad = auth.checkOtp(target, body.verificationId, body.token)
    if (bad) return json(res, 200, { error: { message: bad } })
    let user = await auth.findUser(target)
    if (!user) {
      /* 注册（无论邮箱还是手机号）都要求设密码，之后统一用「账号 + 密码」登录 */
      if (!body.isExistingUser && !body.password) return json(res, 200, { error: { message: '请设置至少 6 位的登录密码' } })
      user = await auth.createUser({ email: body.email, phone: body.phone, password: body.password })
    }
    return json(res, 200, { data: { session: { user: { id: user.id, email: user.email } }, token: auth.signToken(user.id) } })
  }

  if (p === '/api/auth/reset' && req.method === 'POST') {
    /* 忘记密码：真实模式发重置码邮件；演示模式维持原提示（没有发信通道） */
    const email = String(body.email || '').trim()
    if (!auth.smtpReal()) {
      return json(res, 200, { error: { message: '演示模式不发邮件。请联系管理员在数据库重置密码，或用「验证码登录」进入。' } })
    }
    if (!email) return json(res, 200, { error: { message: '请填写邮箱' } })
    const user = await auth.findUser({ email })
    if (!user) return json(res, 200, { error: { message: '该邮箱没有注册过账号' } })
    try {
      await auth.sendResetCode({ email })
    } catch (err) {
      return json(res, 200, { error: { message: err.public ? err.message : '重置码发送失败，请稍后重试' } })
    }
    return json(res, 200, { data: { sent: true } })
  }

  if (p === '/api/auth/reset-confirm' && req.method === 'POST') {
    const email = String(body.email || '').trim()
    const code = String(body.code || '').trim()
    const password = String(body.password || '')
    if (!email || !code) return json(res, 200, { error: { message: '请填写邮箱和重置验证码' } })
    if (password.length < 6) return json(res, 200, { error: { message: '新密码至少 6 位' } })
    const bad = auth.checkResetCode({ email }, code)
    if (bad) return json(res, 200, { error: { message: bad } })
    const user = await auth.findUser({ email })
    if (!user) return json(res, 200, { error: { message: '该邮箱没有注册过账号' } })
    await auth.updatePassword(user.id, password)
    return json(res, 200, { data: { session: { user: { id: user.id, email: user.email } }, token: auth.signToken(user.id) } })
  }

  /* ---- 以下都需要登录（含账号仍存在校验） ---- */
  const me = currentAuth(req)
  const uid = me && me.uid
  const isDemo = !!(me && me.demo)
  if (!uid || !(await liveUser(uid))) return json(res, 401, { error: { message: '登录已过期，请重新登录' } })
  const profile = await getProfile(uid)

  if (p.startsWith('/api/db/')) {
    const [, , , table, op] = p.split('/')
    const rows = await dbOp(uid, profile, table, op, body, isDemo)
    return json(res, 200, { data: rows })
  }

  if (p.startsWith('/api/rpc/')) {
    const fn = p.split('/')[3]
    const params = body.params || body || {}

    /* 演示模式：写入类接口一律拒绝 */
    if (isDemo && WRITE_RPCS.has(fn)) return json(res, 200, { error: { message: '演示模式为只读，不能修改数据' } })

    /* 归档开课：更新归档标志 + 清理失去引用的占位课程 */
    if (fn === 'archive_arrangement') {
      const aid = params.p_arrange_id
      const out = await asUser(uid, async (conn) => {
        const [res] = await conn.query('UPDATE course_arrangements SET is_archived = 1 WHERE arrange_id = ?', [aid])
        await conn.query('CALL sp_gc_orphan_placeholders(@removed)')
        const [r2] = await conn.query('SELECT @removed AS removed')
        return { ok: true, arrange_id: Number(aid), updated: res.affectedRows, removed: (r2[0] && r2[0].removed) || 0 }
      })
      return json(res, 200, { data: out })
    }

    /* 名册管理（仅管理员）：读取全名册 + 绑定状态 */
    if (fn === 'admin_roster') {
      if (profile.role !== 'admin') return json(res, 200, { error: { message: '需要管理员权限' } })
      const r = await query(
        `SELECT s.student_id, s.name, s.class_name, s.major_name, s.enroll_year,
                (p.student_id IS NOT NULL) AS bound
           FROM students s
           LEFT JOIN user_profiles p ON p.student_id = s.student_id
          ORDER BY s.enroll_year, s.class_name, s.student_id`)
      return json(res, 200, { data: r.rows })
    }

    /* 账号管理（仅管理员）：列出所有注册账号（users JOIN user_profiles），含角色与绑定学号 */
    if (fn === 'admin_users') {
      if (profile.role !== 'admin') return json(res, 200, { error: { message: '需要管理员权限' } })
      const r = await query(
        `SELECT u.id, u.email, u.phone, u.created_at,
                p.role, p.real_name, p.student_id, p.demo_mode
           FROM users u
           LEFT JOIN user_profiles p ON p.owner_id = u.id
          ORDER BY p.role DESC, u.created_at`)
      const me = profile ? profile.owner_id : null
      return json(res, 200, { data: { me, rows: r.rows } })
    }

    /* 账号管理（仅管理员）：设置某账号的角色（student/admin）。
       保护：①不能修改自己；②不能把「最后一个 admin」降级为 student（避免系统失去管理员）。 */
    if (fn === 'admin_set_role') {
      if (profile.role !== 'admin') return json(res, 200, { error: { message: '需要管理员权限' } })
      const targetId = String(params.p_user_id || '')
      const newRole = String(params.p_role || '')
      if (!targetId) return json(res, 200, { error: { message: '缺少目标账号' } })
      if (targetId === profile.owner_id) return json(res, 200, { error: { message: '不能修改自己的角色' } })
      if (newRole !== 'student' && newRole !== 'admin') return json(res, 200, { error: { message: '角色只能是 student 或 admin' } })
      const out = await asUser(uid, async (conn) => {
        const [ex] = await conn.query('SELECT id FROM users WHERE id = ? LIMIT 1', [targetId])
        if (!ex.length) return { ok: false, error: '目标账号不存在' }
        if (newRole === 'student') {
          const [admins] = await conn.query('SELECT COUNT(*) AS c FROM user_profiles WHERE role = ?', ['admin'])
          if (admins[0].c <= 1) return { ok: false, error: '只剩一个管理员，不能降级，否则系统将无人管理' }
        }
        await conn.query(
          'INSERT INTO user_profiles (owner_id, real_name, role) VALUES (?, ?, ?) ' +
          'ON DUPLICATE KEY UPDATE role = VALUES(role), updated_at = CURRENT_TIMESTAMP',
          [targetId, '新用户', newRole])
        const [np] = await conn.query('SELECT role FROM user_profiles WHERE owner_id = ?', [targetId])
        return { ok: true, role: np[0] ? np[0].role : newRole }
      })
      return json(res, 200, { data: out })
    }

    /* 名册管理（仅管理员）：批量导入/更新名册（按学号 upsert，入学年份缺省按学号前 4 位推算） */
    if (fn === 'admin_import_students') {
      if (profile.role !== 'admin') return json(res, 200, { error: { message: '需要管理员权限' } })
      const rows = Array.isArray(params.p_rows) ? params.p_rows : []
      const out = await asUser(uid, async (conn) => {
        let inserted = 0, updated = 0, skipped = 0
        const errors = []
        for (const row of rows) {
          const sid = String(row.student_id || '').replace(/\s/g, '')
          const name = String(row.name || '').trim()
          if (!/^\d{6,14}$/.test(sid) || !name) { skipped++; errors.push(`学号 ${sid || '空'}（${name || '无姓名'}）行无效`); continue }
          let ey = parseInt(row.enroll_year, 10)
          if (!Number.isInteger(ey) || ey < 2000 || ey > 2100) {
            ey = parseInt(sid.slice(0, 4), 10)
            if (!Number.isInteger(ey) || ey < 2000 || ey > 2100) ey = new Date().getFullYear()
          }
          const cls = String(row.class_name || '').trim()
          const maj = String(row.major_name || '').trim()
          const gen = String(row.gender || '').trim()
          const [ex] = await conn.query('SELECT student_id FROM students WHERE student_id = ? LIMIT 1', [sid])
          if (ex.length) {
            await conn.query(
              'UPDATE students SET name = ?, class_name = ?, major_name = ?, gender = ?, enroll_year = ? WHERE student_id = ?',
              [name, cls, maj, gen, ey, sid])
            updated++
          } else {
            await conn.query(
              'INSERT INTO students (student_id, name, class_name, major_name, gender, enroll_year) VALUES (?, ?, ?, ?, ?, ?)',
              [sid, name, cls, maj, gen, ey])
            inserted++
          }
        }
        return { inserted, updated, skipped, errors }
      })
      return json(res, 200, { data: out })
    }

    const def = RPCS[fn]
    if (!def) return json(res, 200, { error: { message: '未知接口：' + fn } })
    const bound = def(params)
    const out = await asUser(uid, async (conn) => {
      const rows = await runRpc(conn, bound.proc, bound.args)
      if (!bound.json) return rows
      const v = rows[0] ? rows[0].r : null
      if (typeof v === 'string') { try { return JSON.parse(v) } catch (e) { return v } }
      return v
    })
    return json(res, 200, { data: out })
  }

  return json(res, 404, { error: { message: '接口不存在：' + p } })
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error('[API]', req.method, req.url, e.message)
    json(res, 200, { error: { message: e.message || '服务端错误' } })
  })
})

auth.ensureUsersTable()
  .then(() => {
    server.listen(PORT, '127.0.0.1', () => {
      console.log('===========================================')
      console.log('  学涯拼图 · 本机版已启动')
      console.log('  访问地址： http://127.0.0.1:' + PORT + '/')
      console.log('  数据库： MySQL ' + (process.env.MYSQL_HOST || '127.0.0.1') + ':' + (process.env.MYSQL_PORT || 3306) + '/' + (process.env.MYSQL_DATABASE || 'score_db'))
      console.log('===========================================')
    })
  })
  .catch((e) => { console.error('初始化失败：', e.message); process.exit(1) })
