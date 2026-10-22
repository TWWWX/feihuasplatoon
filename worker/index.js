/* 飞花令诗句词库校验 API（Cloudflare Worker + D1）
   GET /api/poetry?q=<诗句>
   说明：q 由前端完成繁→简转换（前端本就依赖 opencc-js）；
        Worker 端只做兜底清洗（去标点/空格，只留汉字）后精确查询。
        Worker 内不再打包 opencc-js，避免词库数据把包体顶爆免费版 1MB 限制。 */
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
  })

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })

    const url = new URL(request.url)
    if (url.pathname !== '/api/poetry') return json({ error: 'not found' }, 404)
    if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405)

    const q = (url.searchParams.get('q') || '').replace(/[^\u4E00-\u9FA5]/g, '')
    if (!q || q.length > 30) return json({ found: false })

    try {
      /* 同句可有多条来源（集句诗等）：优先返回作者、诗名信息最完整的一条 */
      const { results } = await env.DB.prepare(
        `SELECT author, title, dynasty FROM poetry
         WHERE sentence = ?1
         ORDER BY (author = ''), (title = ''), id
         LIMIT 1`
      )
        .bind(q)
        .all()
      const hit = results && results[0]
      return hit ? json({ found: true, data: hit }) : json({ found: false })
    } catch (e) {
      return json({ found: false, error: String(e && e.message) }, 500)
    }
  },

  /* ================= 定时清理：每日删除「createdAt 超 24h 且双方都不在线满 24h（或席位为空）」的房间
     任一席位心跳仍新鲜则保留（长时间连续对局不会被误删）。
     需要两个 Secret（Firebase 控制台 → 项目设置 → 服务账号 → 生成新私钥）：
       npx wrangler secret put FIREBASE_SA_EMAIL   # client_email
       npx wrangler secret put FIREBASE_SA_KEY     # private_key（PEM 全文）
     手动触发测试：npx wrangler deploy 后在 Cloudflare 控制台 Worker → Settings
       → Cron Triggers 点 Run，或 curl 该 Worker 的 /api/poetry 确认活着。 */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      cleanupRooms(env).then(
        (r) => console.log('[cleanup]', r),
        (e) => console.error('[cleanup] failed:', String(e && e.message))
      )
    )
  },
}

/* ---- 服务账号 JWT（RS256, WebCrypto）→ OAuth2 access token ---- */
function b64urlFromBytes(bytes) {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function b64urlFromText(text) {
  return b64urlFromBytes(new TextEncoder().encode(text))
}
function pemToDer(pem) {
  const b64 = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s+/g, '')
  const raw = atob(b64)
  const buf = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i)
  return buf.buffer
}
async function getAccessToken(env) {
  const now = Math.floor(Date.now() / 1000)
  const header = b64urlFromText(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const payload = b64urlFromText(
    JSON.stringify({
      iss: env.FIREBASE_SA_EMAIL,
      scope: 'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    })
  )
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToDer(env.FIREBASE_SA_KEY),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${header}.${payload}`))
  const jwt = `${header}.${payload}.${b64urlFromBytes(new Uint8Array(sig))}`
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  })
  const j = await res.json()
  if (!j.access_token) throw new Error('oauth failed: ' + JSON.stringify(j).slice(0, 300))
  return j.access_token
}

/* ---- shallow 扫 rooms → createdAt 超 24h 且双方都不在线满 24h（或席位为空）才删 ---- */
const RTDB = 'https://feihuasplatoon-default-rtdb.asia-southeast1.firebasedatabase.app'
async function cleanupRooms(env) {
  const token = await getAccessToken(env)
  const auth = `access_token=${encodeURIComponent(token)}`
  const res = await fetch(`${RTDB}/rooms.json?${auth}&shallow=true`)
  if (!res.ok) throw new Error(`rooms scan failed: HTTP ${res.status}`)
  const keys = await res.json()
  if (!keys || typeof keys !== 'object') return 'no rooms'
  const cutoff = Date.now() - 24 * 3600 * 1000
  let scanned = 0
  let removed = 0
  for (const id of Object.keys(keys)) {
    scanned++
    try {
      const m = await fetch(`${RTDB}/rooms/${id}/meta.json?${auth}`)
      const meta = await m.json()
      if (!(meta && typeof meta.createdAt === 'number' && meta.createdAt < cutoff)) continue
      const pr = await fetch(`${RTDB}/rooms/${id}/players.json?${auth}`)
      const players = await pr.json()
      const ps = await fetch(`${RTDB}/rooms/${id}/presence.json?${auth}`)
      const presence = await ps.json()
      /* 空席视为「没人在线」；有人的席位看心跳：缺失或早于 cutoff 即离线满 24h */
      const away24 = (seat) => {
        const seatUid = players && players[seat] && players[seat].uid
        if (!seatUid) return true
        const ts = presence && presence[seat]
        return typeof ts !== 'number' || ts < cutoff
      }
      if (away24('red') && away24('blue')) {
        const del = await fetch(`${RTDB}/rooms/${id}.json?${auth}`, { method: 'DELETE' })
        if (del.ok) removed++
        else console.error(`[cleanup] delete ${id} → HTTP ${del.status}`)
      }
    } catch (e) {
      console.error(`[cleanup] room ${id}:`, String(e && e.message))
    }
  }
  return `scanned=${scanned} removed=${removed}`
}
