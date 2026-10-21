/* ================= 战报截图（PNG）与逐手回放 GIF =================
   从原单页版整体移植：纯 Canvas 手绘、零外部依赖（GIF89a + LZW + 中位切分量化）。
   调用方传入 game 上下文：
     { side, cells, board, log, phase, totalRounds, endless, round, hitKinds, names }
   names = { A, B } 为双方自定义阵营名（缺省回退赤营/青营）。
   直接触发浏览器下载（不弹预览层）。 */

const SHOT_FONT = "'Microsoft YaHei','PingFang SC','Source Han Sans SC','Noto Sans SC',system-ui,sans-serif"
const TEAM_NAME = { A: '赤营', B: '青营' }
/* 取阵营名：优先用双方改过的名字，没传或为空时回退默认 */
function nm(g, t) { return (g.names && g.names[t]) || TEAM_NAME[t] }

function p2(n) { return (n < 10 ? '0' : '') + n }
function stamp() {
  const d = new Date()
  return '' + d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + '-' + p2(d.getHours()) + p2(d.getMinutes())
}
function cssVar(name, fallback) {
  try {
    const v = (getComputedStyle(document.documentElement).getPropertyValue(name) || '').trim()
    return v || fallback
  } catch (e) { return fallback }
}

function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 3000)
}

/* 由棋盘实况统计涂色数（与原版 counts() 一致，不依赖外部分数） */
function counts(g) {
  let a = 0, b = 0
  for (const c of g.board || []) {
    if (c.owner === 'A') a++
    else if (c.owner === 'B') b++
  }
  return { a, b, n: (g.board || []).length - a - b }
}
function flyCount(g, team) {
  return (g.log || []).filter((e) => e.type === 'fly' && (!team || e.team === team)).length
}
function capTotal(g) {
  return (g.log || []).reduce((s, e) => s + (e.type === 'fly' ? e.capture : 0), 0)
}
function lineOf(e) {
  return e.line || e.norm || ''
}

/* 圆角矩形路径（避免依赖 ctx.roundRect 的浏览器版本） */
function rrPath(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}
/* 缩字号以塞进给定宽度；缩到下限仍超宽才截断加省略号 */
function fitText(ctx, text, maxW, maxPx, minPx, weight) {
  let px = maxPx
  while (px > minPx) {
    ctx.font = weight + ' ' + px + 'px ' + SHOT_FONT
    if (ctx.measureText(text).width <= maxW) return { text, px }
    px -= 1
  }
  ctx.font = weight + ' ' + minPx + 'px ' + SHOT_FONT
  let s = text
  while (s.length > 1 && ctx.measureText(s + '…').width > maxW) s = s.slice(0, -1)
  return { text: s + '…', px: minPx }
}
/* 逐段换色写一行字：segs = [[文本, 颜色], ...] */
function drawSegs(ctx, segs, x, y, px, weight) {
  ctx.font = weight + ' ' + px + 'px ' + SHOT_FONT
  ctx.textAlign = 'left'
  let cx = x
  for (let i = 0; i < segs.length; i++) {
    ctx.fillStyle = segs[i][1]
    ctx.fillText(segs[i][0], cx, y)
    cx += ctx.measureText(segs[i][0]).width
  }
  return cx
}
/* 诗句命中字标记（抢夺＝己方笔色实线／新占＝墨黑实线／己方＝灰色点状线）。
   必须在 fillText 之前调用（先线后字）。 */
function drawHitMarks(ctx, g, e, text, x, y, px, weight, G) {
  const map = (g.hitKinds ? g.hitKinds(e) : {}) || {}
  if (!text) return
  let any = false
  for (let i = 0; i < text.length; i++) if (map[text.charAt(i)]) { any = true; break }
  if (!any) return
  ctx.font = weight + ' ' + px + 'px ' + SHOT_FONT
  ctx.textAlign = 'left'
  const oy = y + px * 0.22
  const th = Math.max(1.1, px * 0.125)
  const pen = team === 'A' ? G.inkA : G.inkB
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i), k = map[ch]
    if (!k || seen[ch]) continue
    seen[ch] = 1
    const x0 = ctx.measureText(text.slice(0, i)).width
    if (k === 'hold') {
      ctx.fillStyle = G.hold
      const cw = ctx.measureText(ch).width
      const n = Math.max(1, Math.round(cw / (th * 2.5)))
      const gap = cw / n, dw = Math.min(th * 1.15, gap * 0.62)
      for (let j = 0; j < n; j++) {
        rrPath(ctx, x + x0 + gap * (j + 0.5) - dw / 2, oy, dw, th, th * 0.42)
        ctx.fill()
      }
    } else {
      ctx.fillStyle = k === 'cap' ? pen : G.text
      ctx.fillRect(x + x0, oy, Math.max(1, ctx.measureText(ch).width), th)
    }
  }
}

/* 截图配色：现读 CSS 变量，与页面不漂移 */
function shotColors() {
  return {
    inkA: cssVar('--ink-a', '#C2352A'),
    inkB: cssVar('--ink-b', '#1F79C4'),
    blank: cssVar('--blank', '#EDF1F7'),
    blankText: cssVar('--blank-text', '#33415C'),
    grid: cssVar('--grid', '#9FABBC'),
    text: cssVar('--text', '#1F2937'),
    muted: cssVar('--muted', '#5B6B84'),
    hold: cssVar('--hit-hold', '#6B7688'),
    danger: cssVar('--danger', '#98271D'),
    line: cssVar('--line', '#DCE3EE'),
  }
}

/* ================= PNG 战报 ================= */

function shotMetrics(g) {
  const W = 1160, PAD = 36
  const BW = 601, CS = 600 / g.side
  const recs = (g.log || []).filter((e) => e.type === 'fly' || e.type === 'pass')
  /* 记录按「回合」成行：左列赤营、右列青营，一行即一回合 */
  const roundMap = {}, rounds = []
  recs.forEach((e) => {
    if (!roundMap[e.round]) { roundMap[e.round] = {}; rounds.push(e.round) }
    roundMap[e.round][e.team] = e
  })
  rounds.sort((a, b) => a - b)
  const ROWH = 48, RECHEAD = 36
  const rows = rounds.length
  const headH = 84, gap = 26
  const recH = rows ? RECHEAD + rows * ROWH : 46
  const boardTop = PAD + headH + gap
  const H = boardTop + BW + gap + 30 + recH + PAD
  return { W, PAD, CS, BW, headH, gap, recs, rounds, roundMap, rows, rowH: ROWH, recHeadH: RECHEAD, recH, boardTop, H }
}

function drawShotBoard(ctx, g, x, y, m, G) {
  const cs = m.CS, t = 1
  ctx.fillStyle = G.grid
  ctx.fillRect(x, y, m.BW, m.BW)
  for (let i = 0; i < g.board.length; i++) {
    const col = i % g.side, row = (i - col) / g.side
    const tok = g.board[i].owner ? 'own' + g.board[i].owner : 'blank'
    const mergeR = col < g.side - 1 && tok !== 'blank' && (g.board[i + 1].owner ? 'own' + g.board[i + 1].owner : 'blank') === tok
    const mergeB = row < g.side - 1 && tok !== 'blank' && (g.board[i + g.side].owner ? 'own' + g.board[i + g.side].owner : 'blank') === tok
    const cx = x + t + col * cs, cy = y + t + row * cs
    const w = cs - t + (mergeR ? t : 0), h = cs - t + (mergeB ? t : 0)
    const owner = g.board[i].owner
    ctx.fillStyle = owner === 'A' ? G.inkA : owner === 'B' ? G.inkB : G.blank
    ctx.fillRect(cx, cy, w, h)
    ctx.fillStyle = owner ? '#FFFFFF' : G.blankText
    ctx.font = '600 ' + Math.min(36, Math.round(cs * 0.56)) + 'px ' + SHOT_FONT
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillText(g.board[i].ch, cx + cs / 2, cy + cs / 2 + 1)
  }
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'
}

function drawShotPanel(ctx, g, x, y, w, h, G) {
  const pad = 22
  rrPath(ctx, x + 0.5, y + 0.5, w - 1, h - 1, 14)
  ctx.fillStyle = '#FBFCFE'; ctx.fill()
  ctx.strokeStyle = G.line; ctx.lineWidth = 1; ctx.stroke()

  const c = counts(g)
  const innerR = x + w - pad

  ctx.fillStyle = G.muted; ctx.font = '700 12.5px ' + SHOT_FONT
  ctx.fillText('涂色面积结算', x + pad, y + 32)

  const rowsDef = [[nm(g, 'A'), c.a, G.inkA, G.inkA], [nm(g, 'B'), c.b, G.inkB, G.inkB], ['未被涂色', c.n, G.muted, G.grid]]
  let ry = y + 48
  rowsDef.forEach((r, i) => {
    ctx.fillStyle = i === 2 ? G.blank : r[2]
    rrPath(ctx, x + pad, ry + 8, 15, 15, 4); ctx.fill()
    if (i === 2) {
      ctx.strokeStyle = r[3]; ctx.lineWidth = 1
      rrPath(ctx, x + pad + 0.5, ry + 8.5, 14, 14, 4); ctx.stroke()
    }
    ctx.fillStyle = G.text; ctx.font = '600 15px ' + SHOT_FONT
    ctx.fillText(r[0], x + pad + 24, ry + 21)
    ctx.textAlign = 'right'
    ctx.fillStyle = G.muted; ctx.font = '400 13px ' + SHOT_FONT
    ctx.fillText('格', innerR, ry + 20)
    const uw = ctx.measureText('格').width
    ctx.fillStyle = r[2]; ctx.font = '800 32px ' + SHOT_FONT
    ctx.fillText(String(r[1]), innerR - uw - 6, ry + 25)
    ctx.textAlign = 'left'
    if (i < 2) {
      ctx.strokeStyle = G.line; ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(x + pad, ry + 42.5); ctx.lineTo(innerR, ry + 42.5); ctx.stroke()
    }
    ry += 62
  })

  /* 面积条 */
  const by = ry + 6, bw = w - pad * 2, bh = 16
  rrPath(ctx, x + pad, by, bw, bh, 8)
  ctx.fillStyle = G.blank; ctx.fill()
  ctx.save()
  rrPath(ctx, x + pad, by, bw, bh, 8); ctx.clip()
  const wa = (bw * c.a) / g.board.length, wb = (bw * c.b) / g.board.length
  ctx.fillStyle = G.inkA; ctx.fillRect(x + pad, by, wa, bh)
  ctx.fillStyle = G.inkB; ctx.fillRect(x + pad + wa, by, wb, bh)
  ctx.restore()

  /* 结果条 */
  const sy = by + bh + 18, sh = 54
  const win = c.a > c.b ? 'A' : c.b > c.a ? 'B' : null
  const banner = g.phase === 'ready' ? { t: '尚未开局', f: '#F1F4F9', c: G.muted }
    : g.phase === 'playing' ? { t: '对战进行中 · 第 ' + g.round + (g.endless ? ' 轮 · 战至最后一刻' : ' / ' + g.totalRounds + ' 轮'), f: '#F1F4F9', c: G.muted }
    : win === 'A' ? { t: nm(g, 'A') + '获胜 ｜ ' + c.a + ' : ' + c.b, f: '#FCF0EE', c: G.inkA }
    : win === 'B' ? { t: nm(g, 'B') + '获胜 ｜ ' + c.b + ' : ' + c.a, f: '#EDF4FB', c: G.inkB }
    : { t: '平局 ｜ ' + c.a + ' : ' + c.b, f: '#F1F4F9', c: G.muted }
  rrPath(ctx, x + pad, sy, bw, sh, 11)
  ctx.fillStyle = banner.f; ctx.fill()
  ctx.fillStyle = banner.c; ctx.font = '800 17px ' + SHOT_FONT
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
  ctx.fillText(banner.t, x + pad + bw / 2, sy + sh / 2 + 1)
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'

  /* 统计 */
  let ty = sy + sh + 26
  [[nm(g, 'A') + '出手', flyCount(g, 'A') + ' 句'], [nm(g, 'B') + '出手', flyCount(g, 'B') + ' 句'], ['双方抢夺合计', capTotal(g) + ' 格']]
    .forEach((r) => {
      ctx.fillStyle = G.muted; ctx.font = '400 13.5px ' + SHOT_FONT
      ctx.fillText(r[0], x + pad, ty)
      ctx.textAlign = 'right'
      ctx.fillStyle = G.text; ctx.font = '700 15px ' + SHOT_FONT
      ctx.fillText(r[1], innerR, ty)
      ctx.textAlign = 'left'
      ty += 30
    })

  /* 尾部：图例 + 说明 */
  ctx.strokeStyle = G.line; ctx.lineWidth = 1
  ctx.beginPath(); ctx.moveTo(x + pad, y + 434.5); ctx.lineTo(innerR, y + 434.5); ctx.stroke()

  const tileY = y + 450, tileS = 30
  ;[[G.blank, '未涂色', G.grid], [G.inkA, nm(g, 'A') + '格子', G.inkA], [G.inkB, nm(g, 'B') + '格子', G.inkB]]
    .forEach((t, i) => {
      const tx = x + pad + i * 128
      ctx.fillStyle = t[0]
      rrPath(ctx, tx, tileY, tileS, tileS, 7); ctx.fill()
      ctx.strokeStyle = t[2]; ctx.lineWidth = 1
      rrPath(ctx, tx + 0.5, tileY + 0.5, tileS - 1, tileS - 1, 7); ctx.stroke()
      ctx.fillStyle = G.muted; ctx.font = '400 12px ' + SHOT_FONT
      ctx.fillText(t[1], tx + tileS + 8, tileY + 20)
    })

  ctx.fillStyle = G.muted; ctx.font = '400 12px ' + SHOT_FONT
  ctx.fillText('每句须至少用 1 个未填色格；可命中并抢夺对方已涂格。', x + pad, y + 524)
}

/* 单格内容：一句飞花（或「放弃本回合」）；无记录时留占位短横 */
function drawShotCell(ctx, g, cx, ry, w, e, team, G) {
  const pc = team === 'A' ? G.inkA : G.inkB
  if (!e) {
    ctx.fillStyle = '#9AA7BA'; ctx.font = '400 13px ' + SHOT_FONT
    ctx.fillText('—', cx + 2, ry + 21)
    return
  }
  if (e.type === 'pass') {
    ctx.fillStyle = G.muted; ctx.font = '400 14px ' + SHOT_FONT
    ctx.fillText('放弃本回合', cx + 2, ry + 21)
    ctx.fillStyle = '#9AA7BA'; ctx.font = '400 12px ' + SHOT_FONT
    ctx.fillText('未涂色', cx + 2, ry + 39)
    return
  }
  const fit = fitText(ctx, lineOf(e), w - 6, 18, 12, '600')
  drawHitMarks(ctx, g, e, fit.text, cx + 2, ry + 21, fit.px, '600', G)
  ctx.font = '600 ' + fit.px + 'px ' + SHOT_FONT
  ctx.fillStyle = G.text
  ctx.fillText(fit.text, cx + 2, ry + 21)
  drawSegs(ctx, [
    ['命中 ', G.muted], [String(e.hits), G.muted],
    [' · 新占 ', G.muted], [String(e.blank), pc],
    [' · 抢夺 ', G.muted], [String(e.capture), pc],
    [' · 己方 ', G.muted], [String(e.hold), G.muted],
  ], cx + 2, ry + 39, 12, '400')
}

function drawShotRecords(ctx, g, x, y, m, G) {
  if (!m.rows) {
    ctx.fillStyle = G.muted; ctx.font = '400 14px ' + SHOT_FONT
    ctx.fillText('尚未开始，飞花记录会显示在这里。', x, y + 20)
    return
  }
  const roundW = 60, colGap = 18
  const colW = (m.W - m.PAD * 2 - roundW - colGap * 2) / 2
  const bodyW = m.W - m.PAD * 2
  const xA = x + roundW, xB = xA + colW + colGap

  ctx.fillStyle = G.muted; ctx.font = '700 12px ' + SHOT_FONT
  ctx.fillText('回合', x + 2, y + 17)
  ctx.fillStyle = G.inkA; ctx.font = '700 13.5px ' + SHOT_FONT
  ctx.fillText(nm(g, 'A'), xA + 2, y + 18)
  ctx.fillStyle = G.inkB; ctx.font = '700 13.5px ' + SHOT_FONT
  ctx.fillText(nm(g, 'B'), xB + 2, y + 18)
  ctx.strokeStyle = G.line; ctx.lineWidth = 1
  ctx.beginPath(); ctx.moveTo(x, y + 27.5); ctx.lineTo(x + bodyW, y + 27.5); ctx.stroke()

  const top = y + m.recHeadH
  m.rounds.forEach((r, ri) => {
    const ry = top + ri * m.rowH
    if (ri % 2 === 1) {
      ctx.fillStyle = '#F7F9FC'
      rrPath(ctx, x, ry - 3, bodyW, m.rowH - 2, 6); ctx.fill()
    }
    ctx.fillStyle = G.muted; ctx.font = '600 13px ' + SHOT_FONT
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillText(String(r), x + roundW / 2, ry + 21)
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'

    drawShotCell(ctx, g, xA, ry, colW, m.roundMap[r] && m.roundMap[r].A, 'A', G)
    drawShotCell(ctx, g, xB, ry, colW, m.roundMap[r] && m.roundMap[r].B, 'B', G)

    ctx.strokeStyle = '#EAEFF7'; ctx.lineWidth = 1
    ctx.beginPath(); ctx.moveTo(x, ry + m.rowH - 2.5); ctx.lineTo(x + bodyW, ry + m.rowH - 2.5); ctx.stroke()
  })
}

function buildShotCanvas(g) {
  const m = step('shotMetrics', () => shotMetrics(g))
  const cv = document.createElement('canvas')
  /* 2 倍分辨率；但 iOS Safari 画布总面积上限约 16.7M px²（4096×4096），
     超限时 getContext('2d') 直接返回 null —— 按面积自适应降倍率兜底 */
  const MAX_AREA = 14 * 1024 * 1024
  let s = 2
  if (m.W * m.H * s * s > MAX_AREA) s = Math.max(1, Math.floor(Math.sqrt(MAX_AREA / (m.W * m.H))))
  cv.width = m.W * s; cv.height = m.H * s
  const ctx = cv.getContext && cv.getContext('2d')
  if (!ctx) return null
  ctx.scale(s, s)

  const G = shotColors()
  ctx.fillStyle = '#FFFFFF'
  ctx.fillRect(0, 0, m.W, m.H)

  const d = new Date()
  ctx.fillStyle = G.text; ctx.font = '800 30px ' + SHOT_FONT
  ctx.fillText('飞花斯普拉遁 · 对战战报', m.PAD, m.PAD + 30)

  ctx.textAlign = 'right'
  ctx.fillStyle = G.muted; ctx.font = '400 13px ' + SHOT_FONT
  ctx.fillText('生成时间 ' + d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) +
    ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes()), m.W - m.PAD, m.PAD + 18)
  ctx.textAlign = 'left'
  ctx.fillStyle = G.muted; ctx.font = '400 13.5px ' + SHOT_FONT
  ctx.fillText(g.side + '×' + g.side + ' 棋盘 ｜ ' +
    (g.endless ? '战至最后一刻' : '共 ' + g.totalRounds + ' 轮 ｜ 双方各出手 ' + g.totalRounds + ' 次') +
    ' ｜ 已记录 ' + m.recs.length + ' 手', m.PAD, m.PAD + 58)

  step('drawShotBoard', () => drawShotBoard(ctx, g, m.PAD, m.boardTop, m, G))
  step('drawShotPanel', () => drawShotPanel(ctx, g, m.PAD + m.BW + 24, m.boardTop, m.W - m.PAD * 2 - m.BW - 24, m.BW, G))

  const recTop = m.boardTop + m.BW + m.gap
  ctx.fillStyle = G.text; ctx.font = '700 15px ' + SHOT_FONT
  ctx.fillText('飞花记录', m.PAD, recTop + 16)
  step('drawShotRecords', () => drawShotRecords(ctx, g, m.PAD, recTop + 30, m, G))

  return cv
}

/* 带阶段标记的绘制调用：任何一步抛错，错误信息前缀即阶段名（用于线上定位） */
function step(name, fn) {
  try {
    return fn()
  } catch (e) {
    throw new Error('[' + name + '] ' + ((e && e.message) || e))
  }
}

export function exportShotPng(g, flash) {
  let cv = null
  try { cv = buildShotCanvas(g) } catch (e) {
    console.error('[export] buildShotCanvas 异常：', e)
    flash('✕ 导出失败：' + ((e && e.message) || e) + '（请把这条提示和控制台红字截图反馈）', 'err')
    return
  }
  if (!cv) {
    flash('✕ 当前环境不支持导出截图（无法创建画布）。', 'err')
    return
  }
  const name = '飞花斯普拉遁-战报-' + stamp() + '.png'
  flash('正在生成截图…', 'ok')
  const finish = (blob) => {
    if (blob) {
      saveBlob(blob, name)
      flash('✓ 已下载截图（含棋盘与飞花记录）：' + name, 'ok')
    } else {
      flash('✕ 生成截图失败：浏览器拒绝了 Blob 导出。', 'err')
    }
  }
  if (cv.toBlob) {
    cv.toBlob((b) => finish(b || null), 'image/png')
  } else {
    try {
      const bin = atob(cv.toDataURL('image/png').split(',')[1])
      const arr = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
      finish(new Blob([arr], { type: 'image/png' }))
    } catch (e) { finish(null) }
  }
}

/* ================= 逐手回放 GIF（GIF89a + LZW + 中位切分，零依赖） ================= */

class bytesSink {
  constructor() { this.a = new Uint8Array(1 << 16); this.n = 0 }
  need(k) {
    if (this.n + k <= this.a.length) return
    let cap = this.a.length
    while (cap < this.n + k) cap *= 2
    const t = new Uint8Array(cap)
    t.set(this.a.subarray(0, this.n))
    this.a = t
  }
  b(v) { this.need(1); this.a[this.n++] = v & 255 }
  u16(v) { this.b(v & 255); this.b((v >>> 8) & 255) }
  arr(src) { this.need(src.length); for (let i = 0; i < src.length; i++) this.a[this.n++] = src[i] }
  str(s) { for (let i = 0; i < s.length; i++) this.b(s.charCodeAt(i)) }
  out() { return this.a.subarray(0, this.n) }
}

/* 回放序列：从空盘开始，逐条飞花记录重放，得到每手的棋盘快照 */
function gifHistory(g) {
  const owners = new Array(g.board.length).fill(null)
  const snaps = [{ owners: owners.slice(), rec: null, changed: [] }]
  for (const e of g.log) {
    if (e.type !== 'fly' && e.type !== 'pass') continue
    const changed = []
    if (e.type === 'fly') {
      for (const idx of cellsOfIn(g, e)) {
        if (idx == null || idx < 0 || idx >= owners.length) continue
        if (owners[idx] !== e.team) { owners[idx] = e.team; changed.push(idx) }
      }
    }
    snaps.push({ owners: owners.slice(), rec: e, changed })
  }
  /* 已结算：补一帧「结果」画面，别让动图停在最后一手上 */
  if (g.phase === 'over' && snaps.length > 1) {
    snaps.push({ owners: owners.slice(), rec: { type: 'end' }, changed: [] })
  }
  return snaps
}

/* 与 App.vue 的 cellsOf 等价：优先用记录里的 cells，旧记录按诗句里的字重新定位 */
function cellsOfIn(g, e) {
  if (e.cells) return e.cells
  const set = {}
  for (const ch of lineOf(e)) set[ch] = true
  const out = []
  g.board.forEach((c, k) => { if (set[c.ch]) out.push(k) })
  return out
}

function gifMetrics(g) {
  const PAD = 24, W = 620
  /* 10×10 及以上格子封顶 52px；5–9 路小棋盘撑满可用宽度，构图才饱满 */
  const fill = Math.floor((W - (PAD + 16) * 2) / g.side)
  const CS = g.side >= 10 ? Math.min(52, fill) : fill
  const BW = g.side * CS + 1
  const headH = 44
  const boardTop = PAD + headH
  const stripTop = boardTop + BW + 14
  const stripH = 100
  const H = stripTop + stripH + PAD
  const S = GIF_WIDTH / W
  return { W, H, PAD, CS, BW, headH, boardTop, stripTop, stripH, bx: Math.floor((W - BW) / 2), S, PW: GIF_WIDTH, PH: Math.round(H * S) }
}

function gifCounts(owners) {
  let a = 0, b = 0
  for (let i = 0; i < owners.length; i++) {
    if (owners[i] === 'A') a++
    else if (owners[i] === 'B') b++
  }
  return { a, b, n: owners.length - a - b }
}

function drawGifBoard(ctx, g, m, snap, G) {
  const cs = m.CS, x = m.bx, y = m.boardTop, t = 1
  const owners = snap.owners
  const tok = (i) => (owners[i] ? 'own' + owners[i] : 'blank')
  ctx.fillStyle = G.grid
  ctx.fillRect(x, y, m.BW, m.BW)
  for (let i = 0; i < owners.length; i++) {
    const col = i % g.side, row = (i - col) / g.side
    const tk = tok(i)
    const mergeR = col < g.side - 1 && tk !== 'blank' && tok(i + 1) === tk
    const mergeB = row < g.side - 1 && tk !== 'blank' && tok(i + g.side) === tk
    const cx = x + t + col * cs, cy = y + t + row * cs
    const w = cs - t + (mergeR ? t : 0), h = cs - t + (mergeB ? t : 0)
    const o = owners[i]
    ctx.fillStyle = o === 'A' ? G.inkA : o === 'B' ? G.inkB : G.blank
    ctx.fillRect(cx, cy, w, h)
    ctx.fillStyle = o ? '#FFFFFF' : G.blankText
    ctx.font = '600 ' + Math.round(cs * 0.56) + 'px ' + SHOT_FONT
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillText(g.board[i].ch, cx + cs / 2, cy + cs / 2 + 1)
  }
  /* 本手刚变化的格子：白色内描边，一眼看出这手涂了哪几格 */
  if (snap.changed && snap.changed.length) {
    ctx.strokeStyle = '#FFFFFF'
    ctx.lineWidth = 3
    for (const q of snap.changed) {
      const qc = q % g.side, qr = (q - qc) / g.side
      const bx = x + t + qc * cs, by = y + t + qr * cs
      ctx.strokeRect(bx + 2.5, by + 2.5, cs - t - 5, cs - t - 5)
    }
  }
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'
}

function drawGifChrome(ctx, g, m, snap, i, total, G) {
  const c = gifCounts(snap.owners)

  const rec0 = snap.rec
  let title = '飞花斯普拉遁 · '
  if (g.endless) {
    title += '战至最后一刻'
  } else {
    let rNow = 1
    if (rec0 && rec0.round) rNow = rec0.round
    else if (rec0 && rec0.type === 'end') rNow = g.totalRounds
    if (rNow > g.totalRounds) rNow = g.totalRounds
    title += '第 ' + rNow + ' / ' + g.totalRounds + ' 轮'
  }
  ctx.fillStyle = G.text; ctx.font = '800 22px ' + SHOT_FONT
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'
  ctx.fillText(title, m.PAD, m.PAD + 21)
  ctx.textAlign = 'right'
  ctx.fillStyle = G.muted; ctx.font = '400 13px ' + SHOT_FONT
  ctx.fillText(i === 0 ? '开局前' : rec0 && rec0.type === 'end' ? '结算' : '第 ' + i + ' / ' + total + ' 手', m.W - m.PAD, m.PAD + 20)
  ctx.textAlign = 'left'

  /* 信息条 */
  const sw = m.W - (m.PAD - 6) * 2, sx = m.PAD - 6, sy = m.stripTop, sh = m.stripH
  const rec = snap.rec
  const isEnd = rec && rec.type === 'end'
  rrPath(ctx, sx + 0.5, sy + 0.5, sw - 1, sh - 1, 12)
  ctx.fillStyle = '#FBFCFE'; ctx.fill()
  ctx.strokeStyle = G.line; ctx.lineWidth = 1; ctx.stroke()

  const ip = sx + 16, ir = sx + sw - 16

  /* 第一行：出手方（结算帧显示胜负）；右侧比分 */
  const winColor = c.a > c.b ? G.inkA : c.b > c.a ? G.inkB : G.muted
  const dot = !rec ? G.grid : isEnd ? winColor : rec.team === 'A' ? G.inkA : G.inkB
  ctx.fillStyle = dot
  ctx.beginPath(); ctx.arc(ip + 5, sy + 21, 5, 0, Math.PI * 2); ctx.fill()
  if (!rec) {
    ctx.fillStyle = G.muted; ctx.font = '700 14.5px ' + SHOT_FONT
    ctx.fillText('开局前 · 暂无飞花记录', ip + 18, sy + 26)
  } else if (isEnd) {
    ctx.fillStyle = winColor; ctx.font = '700 14.5px ' + SHOT_FONT
    ctx.fillText('对战结束 · ' + (c.a > c.b ? nm(g, 'A') + '获胜' : c.b > c.a ? nm(g, 'B') + '获胜' : '平局'), ip + 18, sy + 26)
  } else {
    ctx.fillStyle = rec.team === 'A' ? G.inkA : G.inkB
    ctx.font = '700 14.5px ' + SHOT_FONT
    ctx.fillText(nm(g, rec.team) + ' · 第 ' + rec.round + ' 轮', ip + 18, sy + 26)
  }

  /* 比分（右侧，逐段量宽后右对齐） */
  const segs = [
    [nm(g, 'A') + ' ', 13, G.muted], [String(c.a), 20, G.inkA],
    [' : ', 14, G.muted], [String(c.b), 20, G.inkB], [' ' + nm(g, 'B'), 13, G.muted],
  ]
  let tw = 0
  segs.forEach((s) => { ctx.font = '800 ' + s[1] + 'px ' + SHOT_FONT; tw += ctx.measureText(s[0]).width })
  let px2 = ir - tw
  segs.forEach((s) => {
    ctx.font = (s[1] >= 20 ? '800 ' : '400 ') + s[1] + 'px ' + SHOT_FONT
    ctx.fillStyle = s[2]
    ctx.textAlign = 'left'
    ctx.fillText(s[0], px2, sy + 27)
    px2 += ctx.measureText(s[0]).width
  })

  /* 第二行：本手诗句 + 明细 */
  const ly = sy + 56
  if (!rec) {
    ctx.fillStyle = G.muted; ctx.font = '400 14px ' + SHOT_FONT
    ctx.fillText(g.side + ' × ' + g.side + ' 共 ' + g.board.length + ' 格，等待双方飞花。', ip, ly)
  } else if (isEnd) {
    drawSegs(ctx, [
      ['共 ' + total + ' 手 · ' + nm(g, 'A') + ' ', G.muted], [String(c.a), G.inkA],
      [' 格 ／ ' + nm(g, 'B') + ' ', G.muted], [String(c.b), G.inkB],
      [' 格 ／ 未涂色 ', G.muted], [String(c.n), G.muted], [' 格', G.muted],
    ], ip, ly, 13.5, '400')
  } else if (rec.type === 'pass') {
    ctx.fillStyle = G.muted; ctx.font = '600 14px ' + SHOT_FONT
    ctx.fillText('放弃本回合 · 未涂色', ip, ly)
  } else {
    const fits = fitText(ctx, lineOf(rec), sw - 32 - 196, 17, 12, '600')
    drawHitMarks(ctx, g, rec, fits.text, ip, ly, fits.px, '600', G)
    ctx.font = '600 ' + fits.px + 'px ' + SHOT_FONT
    ctx.fillStyle = G.text
    ctx.fillText(fits.text, ip, ly)
    const pw = ctx.measureText(fits.text).width
    const pc = rec.team === 'A' ? G.inkA : G.inkB
    drawSegs(ctx, [
      ['命中 ', G.muted], [String(rec.hits), G.muted],
      [' · 新占 ', G.muted], [String(rec.blank), pc],
      [' · 抢夺 ', G.muted], [String(rec.capture), pc],
      [' · 己方 ', G.muted], [String(rec.hold), G.muted],
    ], ip + pw + 12, ly, 12.5, '400')
  }

  /* 第三行：规则提示 */
  ctx.fillStyle = G.muted; ctx.font = '400 11.5px ' + SHOT_FONT
  ctx.fillText('每句须至少用 1 个未填色格；可命中并抢夺对方已涂格。', ip, sy + sh - 14)
}

function drawGifFrame(ctx, g, m, snap, i, total, G) {
  ctx.setTransform(m.S, 0, 0, m.S, 0, 0)
  ctx.fillStyle = '#FFFFFF'
  ctx.fillRect(0, 0, m.W, m.H)
  drawGifBoard(ctx, g, m, snap, G)
  drawGifChrome(ctx, g, m, snap, i, total, G)
}

/* ---- 中位切分量化 ---- */
function quantizeColors(hist, maxColors) {
  const items = []
  hist.forEach((n, k) => { items.push([(k >>> 16) & 255, (k >>> 8) & 255, k & 255, n]) })
  if (items.length <= maxColors) return items.map((it) => [it[0], it[1], it[2]])
  function mkBox(arr) {
    const mn = [255, 255, 255], mx = [0, 0, 0]
    let cnt = 0
    for (let i = 0; i < arr.length; i++) {
      const it = arr[i]
      for (let c = 0; c < 3; c++) {
        if (it[c] < mn[c]) mn[c] = it[c]
        if (it[c] > mx[c]) mx[c] = it[c]
      }
      cnt += it[3]
    }
    const rg = [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]]
    const ch = rg[0] >= rg[1] ? (rg[0] >= rg[2] ? 0 : 2) : rg[1] >= rg[2] ? 1 : 2
    return { items: arr, ch, range: rg[ch], cnt, mn, mx }
  }
  const boxes = [mkBox(items)]
  while (boxes.length < maxColors) {
    let bi = -1, best = 0
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i]
      if (b.items.length < 2 || b.range <= 0) continue
      const score = b.range * Math.log(1 + b.cnt)
      if (score > best) { best = score; bi = i }
    }
    if (bi < 0) break
    const box = boxes[bi], ch2 = box.ch
    box.items.sort((p, q) => p[ch2] - q[ch2])
    const half = box.cnt / 2
    let acc = 0, cut = 1
    for (let k = 0; k < box.items.length - 1; k++) {
      acc += box.items[k][3]
      cut = k + 1
      if (acc >= half) break
    }
    const left = box.items.slice(0, cut), right = box.items.slice(cut)
    if (!left.length || !right.length) break
    boxes.splice(bi, 1, mkBox(left), mkBox(right))
  }
  return boxes.map((b) => {
    let r = 0, gg = 0, bl = 0, tot = 0
    for (const it of b.items) { r += it[0] * it[3]; gg += it[1] * it[3]; bl += it[2] * it[3]; tot += it[3] }
    return [Math.round(r / tot), Math.round(gg / tot), Math.round(bl / tot)]
  })
}

function nearestColor(r, g2, b, pal) {
  let best = 0, bd = Infinity
  for (let i = 0; i < pal.length; i++) {
    const p = pal[i]
    const dr = r - p[0], dg = g2 - p[1], db = b - p[2]
    const d = dr * dr * 3 + dg * dg * 6 + db * db
    if (d < bd) { bd = d; best = i }
  }
  return best
}

/* 帧间差分：返回两张图不同的外接矩形；完全相同则返回 null */
function diffRect(a, b, W, H) {
  let minX = W, minY = H, maxX = -1, maxY = -1
  for (let y = 0; y < H; y++) {
    const base = y * W * 4
    for (let x = 0; x < W * 4; x += 4) {
      const p = base + x
      if (a[p] !== b[p] || a[p + 1] !== b[p + 1] || a[p + 2] !== b[p + 2]) {
        const pxi = x >> 2
        if (pxi < minX) minX = pxi
        if (pxi > maxX) maxX = pxi
        if (y < minY) minY = y
        maxY = y
      }
    }
  }
  if (maxX < 0) return null
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }
}

/* 矩形区域 → 调色板索引；与上一帧相同的像素填 0（透明），让 LZW 只压真实变化 */
function mapRegion(data, prev, W, rect, pal, lut, out) {
  let q = 0
  for (let y = 0; y < rect.h; y++) {
    let base = ((rect.y + y) * W + rect.x) * 4
    for (let x = 0; x < rect.w; x++, base += 4) {
      const p = base
      if (prev && data[p] === prev[p] && data[p + 1] === prev[p + 1] && data[p + 2] === prev[p + 2]) {
        out[q++] = 0
        continue
      }
      const k = (data[p] << 16) | (data[p + 1] << 8) | data[p + 2]
      let v = lut[k]
      if (!v) {
        v = nearestColor(data[p], data[p + 1], data[p + 2], pal) + 2
        lut[k] = v
      }
      out[q++] = v - 1
    }
  }
}

/* ---- LZW（GIF 变体：按位打包 + 255 字节子块） ---- */
const LZW_DICT = new Int32Array(1 << 20)
let LZW_GEN = 0

function lzwEncode(px, sink, minCode) {
  const CLEAR = 1 << minCode, EOI = CLEAR + 1
  let codeSize = minCode + 1, next = EOI + 1
  LZW_GEN++
  if (LZW_GEN > 250) { LZW_DICT.fill(0); LZW_GEN = 1 }
  let gen = LZW_GEN

  let acc = 0, nbits = 0
  const chunk = new Uint8Array(255)
  let cn = 0

  function flushChunk() {
    if (!cn) return
    sink.b(cn)
    sink.need(cn)
    for (let i = 0; i < cn; i++) sink.a[sink.n++] = chunk[i]
    cn = 0
  }
  function emit(code) {
    acc |= code << nbits
    nbits += codeSize
    while (nbits >= 8) {
      chunk[cn++] = acc & 255
      if (cn === 255) flushChunk()
      acc >>>= 8
      nbits -= 8
    }
  }

  emit(CLEAR)
  let prefix = px[0]
  for (let i = 1; i < px.length; i++) {
    const k = px[i]
    const key = (prefix << 8) | k
    const v = LZW_DICT[key]
    if ((v >>> 16) === gen) { prefix = v & 0xffff; continue }
    emit(prefix)
    if (next === 4096) {
      emit(CLEAR)
      next = EOI + 1; codeSize = minCode + 1
      LZW_GEN++
      if (LZW_GEN > 250) { LZW_DICT.fill(0); LZW_GEN = 1 }
      gen = LZW_GEN
    } else {
      if (next >= (1 << codeSize)) codeSize++
      LZW_DICT[key] = (gen << 16) | next
      next++
    }
    prefix = k
  }
  emit(prefix)
  emit(EOI)
  if (nbits > 0) {
    chunk[cn++] = acc & 255
    if (cn === 255) flushChunk()
  }
  flushChunk()
  sink.b(0) /* 子块终止符 */
}

/* 全局色表：0 号留白（也是背景色 / 透明索引），真实颜色从 1 号开始 */
function gifWriteHeader(sink, m, pal) {
  sink.str('GIF89a')
  sink.u16(m.PW); sink.u16(m.PH)
  const total = pal.length + 1
  let bits = 1
  while (1 << bits < total) bits++
  if (bits > 8) bits = 8
  sink.b(0x80 | 0x70 | (bits - 1))
  sink.b(0) /* 底色索引 = 0（白） */
  sink.b(0) /* 像素宽高比 */
  const size = 1 << bits
  sink.b(255); sink.b(255); sink.b(255)
  for (let i = 1; i < size; i++) {
    const c = pal[i - 1] || [0, 0, 0]
    sink.b(c[0]); sink.b(c[1]); sink.b(c[2])
  }
  /* Netscape 应用扩展：无限循环 */
  sink.b(0x21); sink.b(0xff); sink.b(0x0b)
  sink.str('NETSCAPE2.0')
  sink.b(0x03); sink.b(0x01); sink.u16(0); sink.b(0)
  return Math.max(2, bits)
}

/* 单帧头：rect 为图像描述符里的矩形；transparent 为真时启用 0 号透明索引 */
function gifWriteFrameHead(sink, rect, delay, minCode, transparent) {
  sink.b(0x21); sink.b(0xf9); sink.b(0x04)
  sink.b(transparent ? 0x05 : 0x04)
  sink.u16(delay)
  sink.b(0)
  sink.b(0)
  sink.b(0x2c)
  sink.u16(rect.x); sink.u16(rect.y)
  sink.u16(rect.w); sink.u16(rect.h)
  sink.b(0)
  sink.b(minCode)
}

function gifFrameDelay(i, n) {
  if (i === 0) return 55
  if (i === n - 1) return 220
  return 44
}

const GIF_WIDTH = 1080
const GIF_COLORS = 96

/* 导出逐手回放 GIF：分帧让出主线程（进度走 flash），完成后直接下载 */
export async function exportShotGif(g, flash) {
  const snaps = gifHistory(g)
  if (snaps.length < 2) {
    flash('✕ 还没有飞花记录：先开局、至少飞一句，再导出 GIF。', 'err')
    return
  }
  const m = gifMetrics(g)
  const cv = document.createElement('canvas')
  cv.width = m.PW; cv.height = m.PH
  const ctx = cv.getContext && cv.getContext('2d')
  if (!ctx) {
    flash('✕ 当前环境不支持导出 GIF（无法创建画布）。', 'err')
    return
  }
  const G = shotColors()
  const hist = new Map()
  const lut = new Uint8Array(1 << 24)
  const px = new Uint8Array(m.PW * m.PH)
  const sink = new bytesSink()
  const n = snaps.length
  const moves = snaps.filter((s) => s.rec && s.rec.type !== 'end').length
  const idle = () => new Promise((r) => setTimeout(r, 0))
  let prev = null, pal = null, minCode = 8, pending = 0

  try {
    flash('正在生成 GIF… 0 / ' + n + ' 帧（帧越多越久，请稍候）', 'ok')
    for (let i = 0; i < n; i++) {
      drawGifFrame(ctx, g, m, snaps[i], i, moves, G)
      const d = ctx.getImageData(0, 0, m.PW, m.PH).data
      /* 隔点取样足够覆盖所有颜色 */
      for (let p = 0; p < d.length; p += 8) {
        const k = (d[p] << 16) | (d[p + 1] << 8) | d[p + 2]
        hist.set(k, (hist.get(k) || 0) + 1)
      }
      if (i % 6 === 5) {
        flash('正在生成 GIF… 分析配色 ' + (i + 1) + ' / ' + n + ' 帧', 'ok')
        await idle()
      }
    }

    pal = quantizeColors(hist, Math.min(254, Math.max(8, GIF_COLORS)))
    minCode = gifWriteHeader(sink, m, pal)

    for (let i = 0; i < n; i++) {
      drawGifFrame(ctx, g, m, snaps[i], i, moves, G)
      const dd = ctx.getImageData(0, 0, m.PW, m.PH).data
      /* 首帧整幅上色；之后只写「与上一帧不同」的矩形，矩形内没变的像素置透明 */
      const rect = i === 0 ? { x: 0, y: 0, w: m.PW, h: m.PH } : diffRect(prev, dd, m.PW, m.PH)
      if (rect) {
        const npx = rect.w * rect.h
        const buf = px.subarray(0, npx)
        mapRegion(dd, i === 0 ? null : prev, m.PW, rect, pal, lut, buf)
        const delay = gifFrameDelay(i, n) + pending
        pending = 0
        gifWriteFrameHead(sink, rect, delay, minCode, i > 0)
        lzwEncode(buf, sink, minCode)
      } else {
        pending += gifFrameDelay(i, n) /* 完全没变的帧：把时长并到下一帧 */
      }
      prev = dd
      if (i % 4 === 3) {
        flash('正在生成 GIF… 编码 ' + (i + 1) + ' / ' + n + ' 帧', 'ok')
        await idle()
      }
    }

    sink.b(0x3b) /* 文件结束符 */
    const bytes = sink.out()
    const blob = new Blob([bytes], { type: 'image/gif' })
    const name = '飞花斯普拉遁-回放-' + stamp() + '.gif'
    saveBlob(blob, name)
    flash('✓ 已生成逐手回放动图并下载（' + n + ' 帧 · ' + Math.max(1, Math.round(bytes.length / 1024)) + ' KB）', 'ok')
  } catch (e) {
    flash('✕ 生成 GIF 失败：' + (e && e.message ? e.message : '未知错误'), 'err')
  }
}
