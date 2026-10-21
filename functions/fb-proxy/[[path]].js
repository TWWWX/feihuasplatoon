/* Pages Functions 反向代理：/fb-proxy/* → Firebase（与前端同域，绕过 workers.dev 阻断）
   - /v1/accounts:*  → identitytoolkit.googleapis.com（登录/注册）
   - /v1/token       → securetoken.googleapis.com（STS 刷新令牌在另一个域名）
   - 其余（rooms/*.json 等） → RTDB asia-southeast1 实例 */
export async function onRequest(context) {
  const { request } = context

  // 秒回 OPTIONS 预检（同域下不会触发，保留作保险 + 本地直连调试用）
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': '*',
      },
    })
  }

  const url = new URL(request.url)
  // 去掉我们自己的前缀 /fb-proxy
  const targetPath = url.pathname.replace(/^\/fb-proxy/, '')

  let targetHost = 'feihuasplatoon-default-rtdb.asia-southeast1.firebasedatabase.app'
  if (targetPath.startsWith('/v1/')) {
    targetHost = targetPath.startsWith('/v1/token')
      ? 'securetoken.googleapis.com'
      : 'identitytoolkit.googleapis.com'
  }

  const targetUrl = new URL(targetPath + url.search, `https://${targetHost}`)

  // 先把 Body 读成 ArrayBuffer，避免流式转发在 PUT/POST 上挂起
  let body = null
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    body = await request.arrayBuffer()
  }

  try {
    const response = await fetch(targetUrl.toString(), {
      method: request.method,
      headers: request.headers,
      body,
    })
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  } catch (e) {
    return new Response(`Pages Proxy Error: ${e.message}`, { status: 502 })
  }
}
