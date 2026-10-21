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
}
