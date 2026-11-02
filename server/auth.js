/* ============================================================
 * 账号与登录态（替代云平台的账号系统）
 * - 密码用 scrypt 加盐哈希
 * - 登录态用 HMAC 签名 token（无状态，存浏览器 localStorage）
 * - 验证码：本机版不接短信/邮件，验证码直接返回给页面（调试用）
 * ============================================================ */
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { query } = require('./db')

const SECRET_FILE = path.join(__dirname, '.secret.key')
function secret() {
  if (!fs.existsSync(SECRET_FILE)) {
    fs.writeFileSync(SECRET_FILE, crypto.randomBytes(32).toString('hex'), { mode: 0o600 })
  }
  return fs.readFileSync(SECRET_FILE, 'utf8').trim()
}

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex')
  const h = crypto.scryptSync(String(pw), salt, 32).toString('hex')
  return `scrypt$${salt}$${h}`
}

function verifyPassword(pw, stored) {
  try {
    const [alg, salt, h] = String(stored).split('$')
    if (alg !== 'scrypt') return false
    const calc = crypto.scryptSync(String(pw), salt, 32).toString('hex')
    return crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(calc, 'hex'))
  } catch (e) { return false }
}

const TOKEN_TTL = 7 * 24 * 3600 * 1000

function signToken(uid, opts) {
  const obj = { uid, exp: Date.now() + TOKEN_TTL }
  if (opts && opts.demo) obj.demo = 1
  const payload = Buffer.from(JSON.stringify(obj)).toString('base64url')
  const sig = crypto.createHmac('sha256', secret()).update(payload).digest('base64url')
  return `${payload}.${sig}`
}

/* 返回完整令牌元信息：{ uid, demo }；verifyToken 保留旧行为（只返回 uid） */
function verifyTokenMeta(token) {
  try {
    const [payload, sig] = String(token).split('.')
    if (!payload || !sig) return null
    const expect = crypto.createHmac('sha256', secret()).update(payload).digest('base64url')
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null
    const obj = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    if (!obj.uid || !obj.exp || obj.exp < Date.now()) return null
    return { uid: obj.uid, demo: obj.demo === 1 }
  } catch (e) { return null }
}

function verifyToken(token) {
  const m = verifyTokenMeta(token)
  return m ? m.uid : null
}

function newUserId() {
  return 'u' + crypto.randomBytes(9).toString('hex')
}

async function ensureUsersTable() {
  await query(`CREATE TABLE IF NOT EXISTS users (
    id         VARCHAR(32)  NOT NULL COMMENT '账号标识',
    email      VARCHAR(100)          DEFAULT NULL COMMENT '邮箱',
    phone      VARCHAR(20)           DEFAULT NULL COMMENT '手机号',
    pass_hash  VARCHAR(255)          DEFAULT NULL COMMENT '口令散列',
    created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '注册时间',
    PRIMARY KEY (id),
    UNIQUE KEY uk_users_email (email),
    UNIQUE KEY uk_users_phone (phone)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
}

async function findUser({ email, phone }) {
  if (email) { const r = await query('SELECT * FROM users WHERE LOWER(email) = LOWER(?)', [email]); return r.rows[0] || null }
  if (phone) { const r = await query('SELECT * FROM users WHERE phone = ?', [phone]); return r.rows[0] || null }
  return null
}

async function createUser({ email, phone, password }) {
  const id = newUserId()
  await query(
    'INSERT INTO users (id, email, phone, pass_hash) VALUES (?,?,?,?)',
    [id, email || null, phone || null, password ? hashPassword(password) : null]
  )
  const r = await query('SELECT * FROM users WHERE id = ?', [id])
  return r.rows[0]
}

/* ---------------- 验证码 ----------------
 * 演示模式（默认）：没配 SMTP 时验证码直接回传页面（devCode），方便本机演示；
 * 真实模式：设置 SMTP_USER / SMTP_PASS 环境变量后，邮箱验证码走真实邮件发送
 * （QQ 邮箱：smtp.qq.com:465 SSL + 授权码），devCode 不再回传。手机短信通道未开通。 */
const SMTP_USER = process.env.SMTP_USER || ''
const SMTP_PASS = process.env.SMTP_PASS || ''
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER
const SMTP_REAL = !!(SMTP_USER && SMTP_PASS)

const OTP = new Map()      // key -> { code, exp, id }
const OTP_TTL = 10 * 60 * 1000

function keyOf({ email, phone }) { return email ? 'e:' + String(email).toLowerCase() : 'p:' + String(phone) }

async function sendOtp(target) {
  const k = keyOf(target)
  const code = String(Math.floor(100000 + Math.random() * 900000))
  const id = 'v' + crypto.randomBytes(6).toString('hex')
  OTP.set(k, { code, id, exp: Date.now() + OTP_TTL })
  console.log(`[OTP] ${k} -> ${code}${SMTP_REAL ? ' （真实邮件）' : ' （演示模式回传）'}`)
  if (!SMTP_REAL) return { verificationId: id, code }
  /* 真实模式：只支持邮箱；发信失败向上抛（index.js 转成用户可读提示） */
  if (!target.email) {
    const err = new Error('短信通道未开通，请改用「邮箱验证码」注册 / 登录')
    err.public = true
    throw err
  }
  const nodemailer = require('nodemailer')
  const transporter = nodemailer.createTransport({
    host: 'smtp.qq.com', port: 465, secure: true,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  })
  await transporter.sendMail({
    from: `"学涯拼图" <${SMTP_FROM}>`,
    to: target.email,
    subject: `学涯拼图 · 登录验证码 ${code}`,
    text: `你的登录验证码是：${code}\n10 分钟内有效。如果不是你本人操作，请忽略本邮件。`,
    html: `<div style="font-family:sans-serif;max-width:420px;margin:0 auto;padding:24px">`
      + `<h2 style="margin:0 0 8px">学涯拼图</h2>`
      + `<p>你的登录验证码是：</p>`
      + `<p style="font-size:26px;letter-spacing:6px;font-weight:700;margin:12px 0">${code}</p>`
      + `<p style="color:#666">10 分钟内有效。如果不是你本人操作，请忽略本邮件。</p></div>`,
  })
  return { verificationId: id, code: null } /* 真实模式不回传验证码 */
}

/* 忘记密码：真实模式下发重置验证码（与登录验证码分开存，互不干扰） */
const RESET = new Map()

async function sendResetCode(target) {
  if (!target.email) {
    const err = new Error('短信通道未开通，请改用「邮箱验证码」找回密码')
    err.public = true
    throw err
  }
  const code = String(Math.floor(100000 + Math.random() * 900000))
  const id = 'r' + crypto.randomBytes(6).toString('hex')
  RESET.set(keyOf(target), { code, id, exp: Date.now() + OTP_TTL })
  console.log(`[RESET] ${keyOf(target)} -> ${code}`)
  const nodemailer = require('nodemailer')
  const transporter = nodemailer.createTransport({
    host: 'smtp.qq.com', port: 465, secure: true,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  })
  await transporter.sendMail({
    from: `"学涯拼图" <${SMTP_FROM}>`,
    to: target.email,
    subject: `学涯拼图 · 密码重置验证码 ${code}`,
    text: `你的密码重置验证码是：${code}\n10 分钟内有效。如果不是你本人操作，请忽略本邮件。`,
    html: `<div style="font-family:sans-serif;max-width:420px;margin:0 auto;padding:24px">`
      + `<h2 style="margin:0 0 8px">学涯拼图 · 密码重置</h2>`
      + `<p>你的密码重置验证码是：</p>`
      + `<p style="font-size:26px;letter-spacing:6px;font-weight:700;margin:12px 0">${code}</p>`
      + `<p style="color:#666">10 分钟内有效。如果不是你本人操作，请忽略本邮件。</p></div>`,
  })
  return { verificationId: id }
}

async function updatePassword(userId, password) {
  await query('UPDATE users SET pass_hash = ? WHERE id = ?', [hashPassword(password), userId])
}

function checkOtp(target, verificationId, token) {
  const k = keyOf(target)
  const rec = OTP.get(k)
  if (!rec) return '验证码已过期，请重新获取'
  if (rec.exp < Date.now()) { OTP.delete(k); return '验证码已过期，请重新获取' }
  if (verificationId && rec.id !== verificationId) return '验证码不匹配，请重新获取'
  if (String(token).trim() !== rec.code) return '验证码错误'
  OTP.delete(k)
  return null
}

function checkResetCode(target, token) {
  const k = keyOf(target)
  const rec = RESET.get(k)
  if (!rec) return '重置验证码已过期，请重新获取'
  if (rec.exp < Date.now()) { RESET.delete(k); return '重置验证码已过期，请重新获取' }
  if (String(token).trim() !== rec.code) return '重置验证码错误'
  RESET.delete(k)
  return null
}

module.exports = {
  hashPassword, verifyPassword, signToken, verifyToken, verifyTokenMeta, newUserId,
  ensureUsersTable, findUser, createUser, sendOtp, checkOtp,
  smtpReal: () => SMTP_REAL, sendResetCode, checkResetCode, updatePassword,
}
