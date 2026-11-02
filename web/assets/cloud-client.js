/* ============================================================
 * 本机版 · 前端数据客户端
 * 统一封装数据库读写、登录与会话接口，底层走本机后端 /api。
 * ============================================================ */
(function () {
  const TOKEN_KEY = 'local_sdk_token'
  const listeners = []

  function getToken() { try { return localStorage.getItem(TOKEN_KEY) || null } catch (e) { return null } }
  function setToken(t) { try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY) } catch (e) {} }

  function notify(event, session) {
    for (const cb of listeners) { try { cb(event, session) } catch (e) {} }
  }

  async function call(path, body, method) {
    const headers = { 'Content-Type': 'application/json' }
    const t = getToken()
    if (t) headers['Authorization'] = 'Bearer ' + t
    let res
    try {
      res = await fetch(path, {
        method: method || 'POST',
        headers,
        body: method === 'GET' ? undefined : JSON.stringify(body || {}),
      })
    } catch (e) {
      return { error: { message: '无法连接本机服务，请确认后端已启动（server 目录 node index.js）' } }
    }
    let payload
    try { payload = await res.json() } catch (e) {
      return { error: { message: '服务返回异常（HTTP ' + res.status + '）' } }
    }
    if (payload && payload.error) return { error: { message: payload.error.message || '请求失败' } }
    return { data: payload ? payload.data : null }
  }

  /* ---------------- 查询构造器（对齐 supabase 风格，可直接 await） ---------------- */
  function makeQuery(table, rpcMode) {
    const st = { table, op: 'select', filters: [], order: null, limit: null, range: null, rows: null, values: null, onConflict: null }

    async function run() {
      const body = {
        filters: st.filters, order: st.order, limit: st.limit, range: st.range,
        rows: st.rows, values: st.values, onConflict: st.onConflict,
      }
      return call('/api/db/' + encodeURIComponent(table) + '/' + st.op, body)
    }

    const q = {
      select() { return q },
      eq(col, val) { st.filters.push({ col, op: 'eq', val }); return q },
      in(col, arr) { st.filters.push({ col, op: 'in', val: arr }); return q },
      order(col, opt) { st.order = { col, ascending: !opt || opt.ascending !== false }; return q },
      limit(n) { st.limit = n; return q },
      range(from, to) { st.range = [from, to]; return q },
      insert(rows) { st.op = 'insert'; st.rows = Array.isArray(rows) ? rows : [rows]; return q },
      upsert(rows, opts) { st.op = 'upsert'; st.rows = Array.isArray(rows) ? rows : [rows]; st.onConflict = (opts && opts.onConflict) || null; return q },
      update(values) { st.op = 'update'; st.values = values; return q },
      delete() { st.op = 'delete'; return q },
      then(resolve, reject) { return run().then(resolve, reject) },
      catch(fn) { return run().catch(fn) },
    }
    return q
  }

  function createClient() {
    return {
      database: {
        from(table) { return makeQuery(table) },
        async rpc(fn, params) { return call('/api/rpc/' + encodeURIComponent(fn), { params: params || {} }) },
      },
      auth: {
        async signInWithPassword({ email, phone, password }) {
          const r = await call('/api/auth/login', { email, phone, password })
          if (r.error) return r
          if (r.data && r.data.token) {
            setToken(r.data.token)
            notify('SIGNED_IN', r.data.session)
          }
          return { data: r.data }
        },
        async sendOtp(payload) {
          return call('/api/auth/send-otp', payload || {})
        },
        async verifyOtp(payload) {
          const r = await call('/api/auth/verify-otp', payload || {})
          if (r.error) return r
          if (r.data && r.data.token) {
            setToken(r.data.token)
            notify('SIGNED_IN', r.data.session)
          }
          return { data: r.data }
        },
        async resetPasswordForEmail(email) {
          const r = await call('/api/auth/reset', { email })
          if (r.error) return r
          /* 返回与云端 SDK 同形的 updateUser：闭包住邮箱，重置成功后自动登录 */
          return { data: { updateUser: async ({ nonce, password }) => {
            const r2 = await call('/api/auth/reset-confirm', { email, code: nonce, password })
            if (r2.error) return r2
            if (r2.data && r2.data.token) {
              setToken(r2.data.token)
              notify('SIGNED_IN', r2.data.session)
            }
            return { data: r2.data }
          } } }
        },
        async demoLogin() {
          /* 演示模式：免注册进入只读演示账号 */
          const r = await call('/api/auth/demo', {})
          if (r.error) return r
          if (r.data && r.data.token) {
            setToken(r.data.token)
            notify('SIGNED_IN', r.data.session)
          }
          return { data: r.data }
        },
        async signOut() {
          await call('/api/auth/logout', {})
          setToken(null)
          notify('SIGNED_OUT', null)
          return { error: null }
        },
        async getSession() {
          /* 与云端 SDK 统一：data 直接是 session 对象（未登录为 null），不再包一层 { session }
             ——app.js 的 boot 按 `const { data: session }` 解构，多包一层会让未登录也判成 truthy */
          if (!getToken()) return { data: null }
          const r = await call('/api/auth/session', null, 'GET')
          if (r.error) { setToken(null); return { data: null } }
          return { data: r.data && r.data.session ? r.data.session : null }
        },
        onAuthStateChange(cb) {
          listeners.push(cb)
          return { data: { subscription: { unsubscribe() { const i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1) } } } }
        },
      },
    }
  }

  /* app.js 按云端 SDK 的名字取：window.WorkBuddyCloud.createWorkBuddyCloud(...)
     本机版这里必须给出同名出口，否则页面会一直等到「服务组件加载失败」 */
  window.WorkBuddyCloud = {
    createWorkBuddyCloud(_config) { return createClient() },
  }
  /* 兼容旧引用名 */
  window.AppCloud = {
    createAppCloud(_config) { return createClient() },
  }
})()
