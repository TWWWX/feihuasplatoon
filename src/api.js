/* Firebase REST 网络层（经 Cloudflare Worker 反向代理，彻底替代 firebase SDK）
   - 认证：Identity Toolkit 匿名登录 accounts:signUp；idToken/uid 存 localStorage
   - 数据：RTDB REST（GET/PUT/PATCH/DELETE + ?auth=idToken），401 自动续期重试一次
   - 说明：idToken 有效期 1 小时；refresh 依赖代理转发 securetoken /v1/token，
     若代理不支持则降级重新匿名注册（uid 会变，需重新加入房间） */

const PROXY = 'https://silent-mud-93b9.tulin5937.workers.dev'
const API_KEY = 'AIzaSyAhkpwJLeTeyq5_pmUSGGYfb6bvgXnFOic'

const LS_TOKEN = 'fh_idToken'
const LS_REFRESH = 'fh_refreshToken'
const LS_UID = 'fh_uid'

let cachedToken = localStorage.getItem(LS_TOKEN) || ''
let cachedUid = localStorage.getItem(LS_UID) || ''

/* 解析 JWT 过期时间（秒），提前 60s 视为过期 */
function tokenExp(token) {
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))
    return payload.exp || 0
  } catch {
    return 0
  }
}
function tokenValid(token) {
  return !!token && tokenExp(token) > Date.now() / 1000 + 60
}

/* 匿名注册：返回 { uid, idToken } */
async function signUp() {
  const res = await fetch(`${PROXY}/v1/accounts:signUp?key=${API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })
  if (!res.ok) throw new Error('匿名登录失败：HTTP ' + res.status)
  const data = await res.json()
  if (!data.idToken || !data.localId) throw new Error('匿名登录返回异常')
  cachedToken = data.idToken
  cachedUid = data.localId
  localStorage.setItem(LS_TOKEN, cachedToken)
  localStorage.setItem(LS_UID, cachedUid)
  if (data.refreshToken) localStorage.setItem(LS_REFRESH, data.refreshToken)
  return { uid: cachedUid, idToken: cachedToken }
}

/* 刷新 idToken：成功返回 { uid, idToken }，失败返回 null */
async function refreshToken() {
  const rt = localStorage.getItem(LS_REFRESH)
  if (!rt) return null
  const res = await fetch(`${PROXY}/v1/token?key=${API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: rt }),
  })
  if (!res.ok) return null
  const data = await res.json()
  /* STS 返回字段名与 signUp 不同：id_token / user_id / refresh_token */
  if (!data.id_token) return null
  cachedToken = data.id_token
  if (data.user_id) cachedUid = data.user_id
  localStorage.setItem(LS_TOKEN, cachedToken)
  localStorage.setItem(LS_UID, cachedUid)
  if (data.refresh_token) localStorage.setItem(LS_REFRESH, data.refresh_token)
  return { uid: cachedUid, idToken: cachedToken }
}

/* 确保已登录且 token 未过期，返回 { uid, idToken } */
export async function ensureAuth() {
  if (tokenValid(cachedToken) && cachedUid) return { uid: cachedUid, idToken: cachedToken }
  const renewed = await refreshToken().catch(() => null)
  if (renewed && tokenValid(renewed.idToken)) return renewed
  return signUp()
}

/* 带 401 自动续期的 RTDB REST 请求；失败抛 Error(error 信息) */
async function authedRequest(method, path, body) {
  await ensureAuth()
  /* 读请求（GET/DELETE，无 body）不带任何自定义头 → 浏览器视为「简单请求」，
     直接跳过 OPTIONS 预检，避免预检被拖住导致 21s 超时 / Failed to fetch */
  const cleanPath = path.replace(/^\/+/, '')
  const doFetch = () =>
    fetch(`${PROXY}/${cleanPath}.json?auth=${encodeURIComponent(cachedToken)}`, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  let res = await doFetch()
  if (res.status === 401) {
    const renewed = (await refreshToken().catch(() => null)) || (await signUp().catch(() => null))
    if (renewed) res = await doFetch()
  }
  if (!res.ok) {
    let msg = 'HTTP ' + res.status
    try {
      const j = await res.json()
      if (j && j.error) msg = typeof j.error === 'string' ? j.error : j.error.message || msg
    } catch {}
    throw new Error(msg)
  }
  const text = await res.text()
  return text ? JSON.parse(text) : null
}

export const rtdbGet = (path) => authedRequest('GET', path)
export const rtdbSet = (path, data) => authedRequest('PUT', path, data)
export const rtdbPatch = (path, data) => authedRequest('PATCH', path, data)
export const rtdbRemove = (path) => authedRequest('DELETE', path)
