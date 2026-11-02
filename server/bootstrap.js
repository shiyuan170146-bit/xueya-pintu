/* ============================================================
 * 初始化本机数据库（MySQL 8）
 *   1) 连接 MySQL 服务（不预选数据库）
 *   2) 执行 sql/score_db_mysql.sql：
 *      建库 → 9 张表 → 3 个视图 → 2 个触发器 → 3 个函数 → 10 个存储过程 → 初始数据
 *   3) 核对各表行数
 * 用法：node bootstrap.js
 * ============================================================ */
const fs = require('fs')
const path = require('path')
const mysql = require('mysql2/promise')

const CFG = {
  host: process.env.MYSQL_HOST || '127.0.0.1',
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || '',
  charset: 'utf8mb4',
  multipleStatements: false,
}

/* 按 DELIMITER 指令切分 SQL 脚本（与 Navicat、mysql 命令行同样的处理方式） */
function splitStatements(text) {
  const lines = text.split(/\r?\n/)
  let delim = ';'
  let buf = []
  const out = []
  for (const line of lines) {
    const m = /^\s*DELIMITER\s+(\S+)\s*$/i.exec(line)
    if (m) { delim = m[1]; continue }
    buf.push(line)
    const joined = buf.join('\n')
    if (joined.trimEnd().endsWith(delim)) {
      const stmt = joined.trimEnd().slice(0, -delim.length).trim()
      if (stmt) out.push(stmt)
      buf = []
    }
  }
  const rest = buf.join('\n').trim()
  if (rest) out.push(rest)
  return out
}

async function main() {
  const scriptPath = path.join(__dirname, 'sql', 'score_db_mysql.sql')
  const stmts = splitStatements(fs.readFileSync(scriptPath, 'utf8'))

  console.log('连接 MySQL ' + CFG.host + ':' + CFG.port + ' …')
  const conn = await mysql.createConnection(CFG)

  console.log('执行建库脚本（' + stmts.length + ' 条语句）…')
  let i = 0
  for (const s of stmts) {
    i += 1
    try {
      await conn.query(s)
    } catch (e) {
      console.error('第 ' + i + ' 条语句执行失败：', e.message)
      console.error(s.slice(0, 200))
      throw e
    }
  }

  await conn.query('USE score_db')
  const [chk] = await conn.query(`SELECT
    (SELECT COUNT(*) FROM students)           AS students,
    (SELECT COUNT(*) FROM courses)            AS courses,
    (SELECT COUNT(*) FROM course_arrangements) AS arrangements,
    (SELECT COUNT(*) FROM scores)             AS scores,
    (SELECT COUNT(*) FROM scores WHERE status='在修') AS zaixiu`)
  console.log('导入结果：', chk[0])

  await conn.end()
  console.log('初始化完成。')
}

main().catch((e) => { console.error('初始化失败：', e.message); process.exit(1) })
