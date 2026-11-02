/* ============================================================
 * 数据库连接层（MySQL 8）
 * - 连接池统一管理连接
 * - 每个请求在独立事务中执行，并把当前登录用户写入 MySQL
 *   会话变量 @app_uid，供存储过程/函数读取当前用户
 * ============================================================ */
const mysql = require('mysql2/promise')

const CFG = {
  host: process.env.MYSQL_HOST || '127.0.0.1',
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || '',
  database: process.env.MYSQL_DATABASE || 'score_db',
}

const pool = mysql.createPool({
  ...CFG,
  waitForConnections: true,
  connectionLimit: 10,
  charset: 'utf8mb4',
  /* 与前端的数据类型约定保持一致：
   * - TINYINT(1) 一律返回布尔值（is_archived / demo_mode 等标志位）
   * - DECIMAL / BIGINT 返回数字（前端有严格相等比较） */
  typeCast(field, next) {
    if (field.type === 'TINY' && field.length === 1) return field.string() === '1'
    if (field.type === 'LONGLONG') return Number(field.string())
    if (field.type === 'NEWDECIMAL') {
      const s = field.string()
      return s === null ? null : Number(s)
    }
    return next()
  },
})

/* 统一查询出口：返回 { rows, rowCount, insertId } */
async function query(sql, params) {
  const [result] = await pool.query(sql, params || [])
  if (Array.isArray(result)) return { rows: result, rowCount: result.length, insertId: 0 }
  return { rows: [], rowCount: result.affectedRows || 0, insertId: result.insertId || 0 }
}

/* 在事务中以某个用户身份执行（@app_uid 供数据库对象读取） */
async function asUser(uid, fn) {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    await conn.query('SET @app_uid = ?', [uid ? String(uid) : ''])
    const out = await fn(conn)
    await conn.commit()
    return out
  } catch (e) {
    try { await conn.rollback() } catch (_) { /* ignore */ }
    throw e
  } finally {
    conn.release()
  }
}

module.exports = { pool, query, asUser, CFG }
