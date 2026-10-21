<script setup>
import { ref, reactive, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import { ensureAuth, rtdbGet, rtdbSet, rtdbPatch, rtdbRemove } from './api'
import { POOL, POOL_SET, EXTRA, EXTRA_WT, EXTRA_FREQ } from './game/pools'

/* ================= Firebase 连接状态（仅连接指示，游戏数据同步后续阶段接入） ================= */
const fbStatus = ref('connecting') // connecting | ok | lost | error
const fbError = ref('')
const uid = ref('')
const connText = computed(
  () => ({ connecting: '连接中…', ok: '已连接 Firebase', lost: '连接断开', error: '连接失败' }[fbStatus.value])
)
const lobbyStatusText = computed(
  () =>
    ({
      connecting: '正在连接 Firebase…',
      ok: '已连接 Firebase，等待创建房间',
      lost: '连接断开，正在重连…',
      error: '连接失败：' + fbError.value,
    }[fbStatus.value])
)

/* ================= 房间联机（Firebase Realtime Database） =================
   rooms/{roomId} = {
     meta:   { hostUid, createdAt },
     players:{ red: { uid, name }, blue: { uid, name } },
     state:  { seed, side, totalRounds, endless, board, currentTurn,
               round, redScore, blueScore, history, status, endReason }
   }
   本地用 A/B 表示赤/青，与云端 red/blue 在同步边界互转。 */
const roomState = ref('lobby') // lobby | playing
const joinCode = ref('')
const roomCode = ref('')
const roomBusy = ref(false)
const lobbyMsg = ref(null)
const players = ref({})
const roomMeta = ref(null)
const myTeam = computed(() => {
  const p = players.value || {}
  if (p.red?.uid === uid.value) return 'A'
  if (p.blue?.uid === uid.value) return 'B'
  return null
})
const isHost = computed(() => roomMeta.value?.hostUid === uid.value)
/* 房主在线心跳：host 写 presence/host，断线时 RTDB 自动删除；非房主据此显示「对战暂停」 */
const hostOnline = ref(true)
const gotRoomSnapshot = ref(false)
const hostOffline = computed(
  () => roomState.value === 'playing' && !isHost.value && gotRoomSnapshot.value && !hostOnline.value
)
/* 回合锁：只有轮到自己阵营时才能出牌（观战身份不能出牌） */
const myTurn = computed(() => myTeam.value !== null && currentTeam.value === myTeam.value)

function genCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let s = ''
  for (let i = 0; i < 6; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)]
  return s
}

/* ---- 可复现随机：mulberry32 + 种子洗牌，双方由同一 seed 生成同一副棋盘 ---- */
function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
function seededShuffle(a, rng) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}
/* 额外字：按唐诗出现次数加权、不放回地抽 k 个（棋盘上同字只能一格） */
function seededPickExtras(k, rng) {
  const idx = []
  const w = []
  for (let i = 0; i < EXTRA.length; i++) {
    idx.push(i)
    w.push(EXTRA_WT[i])
  }
  const out = []
  for (let n = 0; n < k && idx.length; n++) {
    let total = 0
    for (const x of w) total += x
    const r = rng() * total
    let acc = 0
    let pick = w.length - 1
    for (let i = 0; i < w.length; i++) {
      acc += w[i]
      if (r < acc) {
        pick = i
        break
      }
    }
    out.push(EXTRA[idx[pick]])
    idx.splice(pick, 1)
    w.splice(pick, 1)
  }
  return out
}
function buildBoard(seed, side, extraN) {
  const rng = mulberry32(seed)
  const total = side * side
  const picked = seededShuffle(POOL.slice(), rng)
    .slice(0, total - extraN)
    .concat(seededPickExtras(extraN, rng))
  seededShuffle(picked, rng) /* 额外字与基础字混在一起铺，位置不带规律 */
  return picked.map((ch) => ({ ch, owner: null }))
}

/* ---- 本地 A/B ↔ 云端 red/blue ---- */
function localToCloudState() {
  return {
    seed: gameState.seed,
    side: gameState.side,
    totalRounds: gameState.totalRounds,
    endless: gameState.endless,
    board: gameState.board.map((c) => ({
      ch: c.ch,
      owner: c.owner === 'A' ? 'red' : c.owner === 'B' ? 'blue' : null,
    })),
    currentTurn: currentTeam.value === 'A' ? 'red' : 'blue',
    round: currentRound.value,
    redScore: score.value.a,
    blueScore: score.value.b,
    history: gameState.log.map((e) => ({ ...e, team: e.team === 'A' ? 'red' : 'blue' })),
    status: gameState.phase,
    endReason: finishReason.value || null,
  }
}
function cloudToLocalState(st) {
  return {
    seed: st.seed || 0,
    side: st.side || Math.round(Math.sqrt((st.board || []).length)) || 10,
    totalRounds: st.totalRounds || 20,
    endless: !!st.endless,
    board: (st.board || []).map((c) => ({
      ch: c.ch,
      owner: c.owner === 'red' ? 'A' : c.owner === 'blue' ? 'B' : null,
    })),
    /* 由 currentTurn + round 还原 turnNo（本地回合奇偶逻辑依赖它） */
    turnNo: (Math.max(1, st.round || 1) - 1) * 2 + (st.currentTurn === 'blue' ? 2 : 1),
    log: (st.history || []).map((e) => ({ ...e, team: e.team === 'red' ? 'A' : e.team === 'blue' ? 'B' : e.team })),
    phase: st.status || 'ready',
  }
}

/* ---- 轮询同步（REST 无长连接：1s 拉整房，内容有变化才写回本地） ---- */
let pollTimer = null
let lastRoomJson = ''

function startPolling(code) {
  stopPolling()
  lastRoomJson = ''
  pollTimer = setInterval(async () => {
    let val = null
    try {
      val = await rtdbGet(`rooms/${code}`)
      if (fbStatus.value !== 'ok') fbStatus.value = 'ok'
    } catch (e) {
      fbStatus.value = 'lost'
      return
    }
    if (!val) {
      flashTip('房间数据不存在（可能已被删除）。', 'warn')
      stopPolling()
      return
    }
    /* 房主心跳：REST 没有 onDisconnect，用时间戳 + 6s 超时判定在线 */
    if (val.meta && val.meta.hostUid === uid.value) {
      hostOnline.value = true
      rtdbPatch(`rooms/${code}/presence/host`, Date.now()).catch(() => {})
    } else {
      const ts = val.presence && val.presence.host
      hostOnline.value = typeof ts === 'number' && Date.now() - ts < 6000
    }
    /* presence 变化不触发界面刷新，只比对 meta/players/state */
    const json = JSON.stringify([val.meta, val.players, val.state])
    if (json === lastRoomJson) return
    lastRoomJson = json
    applyRoomSnapshot(val)
  }, 1000)
}
function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}
function applyRoomSnapshot(val) {
  roomMeta.value = val.meta || null
  players.value = val.players || {}
  gotRoomSnapshot.value = true
  const st = val.state
  if (!st) return
  const local = cloudToLocalState(st)
  finishReason.value = st.endReason || ''
  gameState.seed = local.seed
  gameState.side = local.side
  gameState.totalRounds = local.totalRounds
  gameState.endless = local.endless
  gameState.board = local.board
  gameState.turnNo = local.turnNo
  gameState.log = local.log
  gameState.phase = local.phase
}

/* ---- 把本地最新状态整体推到云端（提交/放弃/撤销/结算/开局/重抽共用） ---- */
function syncState() {
  if (!roomCode.value) return
  rtdbSet(`rooms/${roomCode.value}/state`, localToCloudState()).catch((err) =>
    flashTip('同步失败：' + err.message, 'err')
  )
}

function enterRoom(code) {
  roomCode.value = code
  sessionStorage.setItem('fh_room', code)
  roomState.value = 'playing'
  startPolling(code)
}
function exitRoom() {
  /* 房主退出：清掉在线心跳，对方会在 6 秒内看到「对战暂停」 */
  stopPolling()
  if (roomCode.value && roomMeta.value?.hostUid === uid.value) {
    rtdbRemove(`rooms/${roomCode.value}/presence/host`).catch(() => {})
  }
  sessionStorage.removeItem('fh_room')
  roomCode.value = ''
  players.value = {}
  roomMeta.value = null
  hostOnline.value = true
  gotRoomSnapshot.value = false
  roomState.value = 'lobby'
}

async function createRoom() {
  if (roomBusy.value) return
  if (!uid.value) {
    lobbyMsg.value = { text: '正在连接 Firebase，请稍候再试。', kind: 'err' }
    return
  }
  roomBusy.value = true
  try {
    let code = null
    for (let i = 0; i < 5; i++) {
      const c = genCode()
      const snap = await rtdbGet(`rooms/${c}`)
      if (snap == null) {
        code = c
        break
      }
    }
    if (!code) throw new Error('房间码分配失败，请重试')
    /* 用当前顶栏设置初始化一局：seed → 棋盘 → 初始 state 写入云端 */
    gameState.side = clampSizeInput()
    gameState.totalRounds = readRounds()
    redrawBoard()
    gameState.phase = 'ready'
    gameState.turnNo = 1
    gameState.log = []
    gameState.undoStack = []
    finishReason.value = ''
    await rtdbSet(`rooms/${code}`, {
      meta: { hostUid: uid.value, createdAt: Date.now() },
      players: { red: { uid: uid.value, name: '房主' } },
      state: localToCloudState(),
    })
    lobbyMsg.value = null
    enterRoom(code)
  } catch (e) {
    lobbyMsg.value = { text: '创建房间失败：' + e.message, kind: 'err' }
  } finally {
    roomBusy.value = false
  }
}

async function joinRoom() {
  if (roomBusy.value) return
  const code = joinCode.value.trim().toUpperCase()
  if (!code) {
    lobbyMsg.value = { text: '请先输入房间码。', kind: 'err' }
    return
  }
  if (!uid.value) {
    lobbyMsg.value = { text: '正在连接 Firebase，请稍候再试。', kind: 'err' }
    return
  }
  roomBusy.value = true
  try {
    /* 规则只把 meta 开放给非成员读取：用 meta 判断房间存在性 */
    const meta = await rtdbGet(`rooms/${code}/meta`)
    if (!meta) throw new Error('房间不存在，请核对房间码')
    if (meta.hostUid !== uid.value) {
      /* 蓝位已有他人则拒绝；否则 PATCH 占位（规则保证不能覆盖他人 uid） */
      const blue = await rtdbGet(`rooms/${code}/players/blue`)
      if (blue && blue.uid && blue.uid !== uid.value) {
        throw new Error('房间已满（赤青两营均有玩家），无法加入')
      }
      await rtdbPatch(`rooms/${code}/players/blue`, { uid: uid.value, name: '玩家' })
    }
    /* 房主本人重连，或自己已在蓝位（幂等覆盖），都直接进入 */
    lobbyMsg.value = null
    enterRoom(code)
  } catch (e) {
    lobbyMsg.value = { text: '加入房间失败：' + e.message, kind: 'err' }
  } finally {
    roomBusy.value = false
  }
}

/* ================= 常量 ================= */
const TEAM_NAME = { A: '赤营', B: '青营' }
const TEAM_MARK = { A: '赤', B: '青' }
/* 建议回合数：大致把棋盘涂到 4~5 成（10×10 → 20 轮、8×8 → 15 轮） */
const SUGGEST_ROUNDS = { 5: 8, 6: 10, 7: 12, 8: 15, 9: 17, 10: 20, 11: 23, 12: 26, 13: 29, 14: 33, 15: 37, 16: 41, 17: 45 }
const suggestRounds = (side) => SUGGEST_ROUNDS[side] || Math.max(8, Math.round((side * side) / 5))

/* ================= 全局游戏状态 ================= */
const gameState = reactive({
  seed: 0, // 随机种子：双方由同一 seed 生成同一副棋盘
  side: 10,
  board: [], // [{ ch, owner: null | 'A' | 'B' }]
  phase: 'ready', // ready | playing | over
  totalRounds: 20,
  endless: false, // 战至最后一刻
  turnNo: 1, // 1-based 总出手次数
  log: [], // 飞花 / 放弃记录
  undoStack: [],
})

/* ---------- 顶栏设置 ---------- */
const sizeInput = ref(10)
const extraInput = ref(0)
const roundInput = ref(suggestRounds(10))
const endlessChk = ref(false)
const fixMode = ref(false)
const allowDup = ref(false)
const keepPunct = ref(false)
const roundAuto = ref(true) // 轮数是否仍跟随棋盘建议值（用户手动改过就置 false）

/* ---------- 派生状态 ---------- */
const cellTotal = computed(() => gameState.side * gameState.side)
const currentTeam = computed(() => (gameState.turnNo % 2 === 1 ? 'A' : 'B'))
const score = computed(() => {
  let a = 0, b = 0, n = 0
  for (const c of gameState.board) {
    if (c.owner === 'A') a++
    else if (c.owner === 'B') b++
    else n++
  }
  return { a, b, n }
})
const currentRound = computed(() => {
  /* 结算后按实际出手数回算，避免无尽局末多数出 1 轮 */
  if (gameState.phase === 'over') {
    const moved = gameState.log.filter((e) => e.type === 'fly' || e.type === 'pass').length
    return Math.max(1, Math.ceil(moved / 2))
  }
  const r = Math.ceil(gameState.turnNo / 2)
  return gameState.endless ? r : Math.min(gameState.totalRounds, r)
})
const phaseText = computed(() => {
  if (gameState.phase === 'ready') return '待开局'
  if (gameState.phase === 'playing') return `进行中 · 轮到 ${TEAM_NAME[currentTeam.value]}`
  return '对战结束'
})
const startLabel = computed(() =>
  gameState.phase === 'playing' ? '对战中' : gameState.phase === 'over' ? '已结束' : '开始对战'
)
const flyTurns = computed(() => gameState.log.filter((e) => e.type === 'fly').length)
const flyLogs = computed(() => gameState.log.filter((e) => e.type === 'fly' || e.type === 'pass').slice().reverse())
const resultFlies = computed(() => gameState.log.filter((e) => e.type === 'fly'))

/* ---------- 字库面板 ---------- */
const poolOn = computed(() => {
  const m = {}
  for (const c of gameState.board) m[c.ch] = true
  return m
})
const extraOnBoard = computed(() => {
  const ex = gameState.board.filter((c) => !POOL_SET[c.ch]).map((c) => c.ch)
  ex.sort((x, y) => (EXTRA_FREQ[y] || 0) - (EXTRA_FREQ[x] || 0))
  return ex
})

/* ---------- 消息条 ---------- */
const msg = ref(null) // { text, kind: ok|warn|err }
function flashTip(text, kind = 'ok') {
  msg.value = { text, kind }
}
function clearMsg() {
  msg.value = null
}

/* ================= 工具函数 ================= */
function cjkOnly(s) {
  return (s || '').replace(/[^\u4e00-\u9fa5]/g, '')
}
/* 飞花记录里的诗句文本：默认把标点等非文字符号折成空格；勾选后原样保留（换行折空格）。
   涂色判定始终只看汉字（cjkOnly），显示口径不影响规则。 */
function fmtPoem(raw, fallback) {
  const s = (raw || '').replace(/\r\n?/g, '\n').trim()
  if (!s) return fallback || ''
  if (keepPunct.value) return s.replace(/\s*\n+\s*/g, ' ')
  return s.replace(/[^\u3400-\u4DBF\u4E00-\u9FA5\u3007A-Za-z0-9]+/g, ' ').trim() || (fallback || '')
}

/* ================= 诗句词库校验（Cloudflare Worker + D1） ================= */
const POETRY_API = 'https://feihua-poetry-api.tulin5937.workers.dev/api/poetry' // 本地调试改回 http://127.0.0.1:8787/api/poetry
let t2s = null /* opencc-js 懒加载：首次提交才加载词典，不拖慢首屏 */
async function toSimplified(s) {
  if (!t2s) {
    const OpenCC = (await import('opencc-js')).default
    t2s = OpenCC.Converter({ from: 't', to: 'cn' })
  }
  return t2s(s)
}
/* 词库查询节流：首个请求立即发出，500ms 内的连按/请求中被拦截（不拖慢正常出牌手感） */
const poetryBusy = ref(false)
let poetryLastAt = 0
/* 词库返回 → 「朝代 · 作者《诗名》」，缺项自动省略 */
function composePoemMeta(d) {
  const who = [d.dynasty, d.author].filter((x) => x).join(' · ')
  const t = d.title ? `《${d.title}》` : ''
  return who ? who + t : t
}

/* ================= 棋盘 ================= */
/* 由 seed 确定性生成：host 重抽时产生新 seed 并随 state 同步，双方棋盘一致 */
function redrawBoard(seed = Math.floor(Math.random() * 2 ** 31)) {
  const cap = Math.min(cellTotal.value, EXTRA.length)
  const extraN = Math.max(0, Math.min(cap, parseInt(extraInput.value, 10) || 0))
  extraInput.value = extraN
  gameState.seed = seed
  gameState.board = buildBoard(seed, gameState.side, extraN)
  previewSet.value = new Set()
  changedNow.value = {}
}

/* 出手前预览：输入句命中的格子刷成当前回合方的半透明色 */
const poemInput = ref('')
const previewSet = ref(new Set())
/* 回合锁：未轮到自己 / 房主离线 / 未开局 时锁定输入框 */
const poemLocked = computed(() => gameState.phase !== 'playing' || !myTurn.value || hostOffline.value)
const poemPlaceholder = computed(() => {
  if (gameState.phase !== 'playing') return '点击上方「开始对战」后解锁'
  if (!myTurn.value || hostOffline.value) return '等待对方出牌...'
  return '在此输入诗句，如：床前明月光，疑是地上霜（回车提交）'
})
function updatePreview() {
  previewSet.value = new Set(cjkOnly(poemInput.value).split(''))
}

/* 本手刚变化的格子：白描边 1.05 秒后褪掉 */
const changedNow = ref({})
let changedTimer = null
function markChanged(map) {
  changedNow.value = map || {}
  if (changedTimer) {
    clearTimeout(changedTimer)
    changedTimer = null
  }
  if (!Object.keys(changedNow.value).length) return
  changedTimer = setTimeout(() => {
    changedTimer = null
    changedNow.value = {}
  }, 1080)
}

/* 每格当前的"视觉颜色令牌"：相邻格令牌相同且非空白 → 格线隐藏，墨块连成整片 */
function colorToken(i) {
  const cell = gameState.board[i]
  if (!cell) return 'blank'
  const o = cell.owner
  if (gameState.phase === 'playing' && previewSet.value.has(cell.ch)) {
    const t = currentTeam.value
    if (o === t) return 'own' + t
    return 'pv' + t + (o || 'N')
  }
  return o ? 'own' + o : 'blank'
}
/* 唯一的格子渲染入口：所有者配色 + 预览配色 + 邻接格线合并 */
function cellClass(i) {
  const cell = gameState.board[i]
  if (!cell) return ['cell']
  const side = gameState.side
  const col = i % side
  const row = (i - col) / side
  const token = colorToken(i)
  const cls = ['cell']
  if (cell.owner) cls.push('own-' + cell.owner)
  if (gameState.phase === 'playing' && previewSet.value.has(cell.ch)) {
    cls.push('pv-' + currentTeam.value)
    if (!cell.owner) cls.push('pv-new')
    else if (cell.owner !== currentTeam.value) cls.push('pv-cap')
    else cls.push('pv-hold')
  }
  if (fixMode.value) cls.push('fixable')
  if (changedNow.value[i]) cls.push('flash')
  const hideR = col === side - 1 || (token !== 'blank' && colorToken(i + 1) === token)
  const hideB = row === side - 1 || (token !== 'blank' && colorToken(i + side) === token)
  if (hideR) cls.push('nb-r')
  if (hideB) cls.push('nb-b')
  return cls
}

/* 修正模式：点击格子循环切换 无主 → 赤 → 青 → 无主 */
function onCellClick(idx) {
  if (!fixMode.value) return
  const order = [null, 'A', 'B']
  const cur = gameState.board[idx].owner
  const next = order[(order.indexOf(cur) + 1) % 3]
  gameState.board[idx].owner = next
  syncState()
  flashTip(`修正：${gameState.board[idx].ch} → ${next ? TEAM_NAME[next] : '无主'}`, 'ok')
}

/* 字号随格子实际宽度走：5×5 不至于小字淹没，17×17 不至于挤成一团 */
const boardEl = ref(null)
const cellFs = ref(27)
const boardStyle = computed(() => ({
  gridTemplateColumns: `repeat(${gameState.side}, 1fr)`,
  '--cell-fs': cellFs.value + 'px',
}))
function sizeCellFont() {
  const w = boardEl.value?.clientWidth || 0
  if (!w) return
  cellFs.value = Math.max(9, Math.min(36, Math.round((w / gameState.side) * 0.54)))
}
watch([roomState, () => gameState.side], async () => {
  await nextTick()
  sizeCellFont()
})

/* ================= 诗句命中标记（记录 / 结算面板共用） ================= */
function cellsOf(e) {
  if (e.cells) return e.cells
  const set = {}
  for (const ch of e.line || '') set[ch] = true
  const out = []
  gameState.board.forEach((c, k) => {
    if (set[c.ch]) out.push(k)
  })
  return out
}
/* 返回 {字: "new"|"cap"|"hold"}：从历史记录重放得到"这一手落子前"每格归谁 */
function hitKinds(e) {
  const owners = gameState.board.map(() => null)
  let out = null
  for (const x of gameState.log) {
    if (x.type !== 'fly' && x.type !== 'pass') continue
    const map = {}
    if (x.type === 'fly') {
      for (const idx of cellsOf(x)) {
        if (idx == null || idx < 0 || idx >= owners.length) continue
        const before = owners[idx]
        map[gameState.board[idx].ch] = before == null ? 'new' : before === x.team ? 'hold' : 'cap'
        owners[idx] = x.team
      }
    }
    if (x === e) out = map
  }
  return out || {}
}
/* 诗句 → 分段数组（命中的字带 new/cap/hold 标记），模板里用 v-for 渲染 */
function poemSegs(e) {
  const s = fmtPoem(e.raw, e.line)
  const map = hitKinds(e)
  const segs = []
  let run = ''
  const seen = {}
  for (const ch of s) {
    const k = map[ch]
    if (!k || seen[ch]) {
      run += ch
      continue
    }
    seen[ch] = 1
    if (run) {
      segs.push({ text: run })
      run = ''
    }
    segs.push({ text: ch, kind: k })
  }
  if (run) segs.push({ text: run })
  return segs
}

/* ================= 核心判定：飞花 ================= */
async function submitLine() {
  if (gameState.phase !== 'playing') return
  if (!myTurn.value) {
    flashTip(myTeam.value === null ? '观战身份不能出牌。' : '还没轮到你出牌，请等待对方。', 'err')
    return
  }
  if (hostOffline.value) {
    flashTip('房主已离线，对战暂停。', 'warn')
    return
  }
  const raw = poemInput.value
  const chars = cjkOnly(raw)
  if (!chars) {
    flashTip('请先输入诗句（仅中文汉字会被识别）。', 'err')
    return
  }
  if (chars.length > 30) {
    flashTip('字数过长：词库仅收录 30 字以内的诗句。', 'err')
    return
  }
  /* 转简体：棋盘与词库都是简体口径，匹配/查库/查重统一用它 */
  const norm = await toSimplified(chars)
  const set = {}
  for (const ch of norm) set[ch] = true

  const hits = [], blanks = [], captures = [], holds = []
  const me = currentTeam.value
  const other = me === 'A' ? 'B' : 'A'
  gameState.board.forEach((cell, idx) => {
    if (set[cell.ch]) {
      hits.push(idx)
      if (!cell.owner) blanks.push(idx)
      else if (cell.owner === other) captures.push(idx)
      else holds.push(idx)
    }
  })

  if (!hits.length) {
    flashTip('✕ 无命中：这句里没有出现棋盘上的任何字，本句无效，请换一句。', 'err')
    return
  }
  if (!blanks.length) {
    flashTip(`✕ 违反规则 3：本句命中的 ${hits.length} 个格子全部已有颜色，没有使用任何一个未填色格，本句无效。`, 'err')
    return
  }
  if (!allowDup.value) {
    const dup = gameState.log.some((e) => e.type === 'fly' && e.norm === norm)
    if (dup) {
      flashTip('✕ 重复句：这句已经飞过了。如需放行，请勾选「允许重复句」。', 'err')
      return
    }
  }

  /* 词库校验：500ms 节流 + 请求中防重入，连按回车不会瞬间打爆接口 */
  if (poetryBusy.value) {
    flashTip('正在校验上一句，请稍候…', 'warn')
    return
  }
  const ts = Date.now()
  if (ts - poetryLastAt < 500) {
    flashTip('操作太快，请稍候再按。', 'warn')
    return
  }
  poetryLastAt = ts
  poetryBusy.value = true
  let poemMeta = ''
  try {
    const res = await fetch(`${POETRY_API}?q=${encodeURIComponent(norm)}`)
    const data = await res.json()
    if (!data || data.found !== true) {
      flashTip('该诗句不在诗库中，请重新输入。', 'err')
      return
    }
    poemMeta = composePoemMeta(data.data || {})
  } catch (e) {
    /* 网络故障/词库服务未部署时放行本句（仅提示未校验）；明确的 found:false 仍然拦截 */
    flashTip('词库服务暂不可用，本句未经校验已放行：' + (e && e.message), 'warn')
  } finally {
    poetryBusy.value = false
  }

  /* 记录快照，供撤销 */
  gameState.undoStack.push({
    board: gameState.board.map((c) => ({ ch: c.ch, owner: c.owner })),
    logLen: gameState.log.length,
    turnNo: gameState.turnNo,
  })

  /* 涂色：只改响应式数据，视图自动更新；同时记下本手变化的格子供白描边 */
  const changed = {}
  hits.forEach((idx) => {
    if (gameState.board[idx].owner !== me) {
      gameState.board[idx].owner = me
      changed[idx] = 1
    }
  })

  gameState.log.push({
    type: 'fly', team: me, round: currentRound.value, line: norm, norm,
    hits: hits.length, blank: blanks.length, capture: captures.length, hold: holds.length,
    raw: (raw || '').trim(), meta: poemMeta, cells: hits.slice(),
  })

  previewSet.value = new Set()
  markChanged(changed)
  flashTip(
    `✓ ${TEAM_NAME[me]} 飞花成功：命中 ${hits.length} 格 → 新占 ${blanks.length} · 抢夺 ${captures.length} · 己方 ${holds.length}。` +
      (captures.length ? `（从对方手中抢下 ${captures.length} 格 🔥）` : ''),
    'ok'
  )
  advance()
  syncState()
}

function advance() {
  poemInput.value = ''
  updatePreview()
  resetTimer()
  gameState.turnNo++
  /* 棋盘填满：任何轮数模式都立即结算 */
  if (score.value.n === 0) {
    finish('棋盘已填满')
    return
  }
  if (!gameState.endless && gameState.turnNo > gameState.totalRounds * 2) finish()
  else focusPoem()
}

function passTurn() {
  if (gameState.phase !== 'playing') return
  if (!myTurn.value || hostOffline.value) {
    flashTip(myTeam.value === null ? '观战身份不能出牌。' : '还没轮到你出牌，请等待对方。', 'err')
    return
  }
  const me = currentTeam.value
  gameState.undoStack.push({
    board: gameState.board.map((c) => ({ ch: c.ch, owner: c.owner })),
    logLen: gameState.log.length,
    turnNo: gameState.turnNo,
  })
  gameState.log.push({ type: 'pass', team: me, round: currentRound.value })
  flashTip(`已记录：${TEAM_NAME[me]} 放弃本回合，未涂色。`, 'warn')
  advance()
  syncState()
}

function undo() {
  if (!gameState.undoStack.length) return
  const snap = gameState.undoStack.pop()
  gameState.board = snap.board.map((c) => ({ ...c }))
  gameState.log = gameState.log.slice(0, snap.logLen)
  gameState.turnNo = snap.turnNo
  gameState.phase = 'playing'
  previewSet.value = new Set()
  if (changedTimer) {
    clearTimeout(changedTimer)
    changedTimer = null
  }
  changedNow.value = {}
  clearMsg()
  flashTip('已撤销上一步。', 'warn')
  focusPoem()
  syncState()
}

/* ================= 结算 ================= */
const showResult = ref(false)
const finishReason = ref('')
/* 结算弹窗跟随 phase：本机结算或云端同步为 over 都会触发 */
watch(
  () => gameState.phase,
  (p) => {
    showResult.value = p === 'over'
  }
)
function finish(reason) {
  gameState.phase = 'over'
  finishReason.value = reason || ''
}
const resultInfo = computed(() => {
  const c = score.value
  let win, name, color
  if (c.a > c.b) {
    win = '赤营获胜'; name = `赤营 ${c.a} : ${c.b} 青营`; color = 'var(--ink-a)'
  } else if (c.b > c.a) {
    win = '青营获胜'; name = `青营 ${c.b} : ${c.a} 赤营`; color = 'var(--ink-b)'
  } else {
    win = '平局'; name = `赤营 ${c.a} : ${c.b} 青营`; color = '#5B6B84'
  }
  const label =
    '对战结束 · ' +
    (finishReason.value === '棋盘已填满'
      ? '棋盘已填满 · 涂色面积结算'
      : gameState.endless
        ? `战至最后一刻 · ${finishReason.value || '手动结算'}`
        : `${gameState.totalRounds} 轮 · 涂色面积结算`)
  return { win, name, color, label }
})
function flyCount(team) {
  return gameState.log.filter((e) => e.type === 'fly' && e.team === team).length
}
function capTotal() {
  return gameState.log.reduce((s, e) => s + (e.type === 'fly' ? e.capture : 0), 0)
}
function again() {
  gameState.phase = 'ready'
  gameState.turnNo = 1
  gameState.log = []
  gameState.undoStack = []
  redrawBoard()
  clearMsg()
  flashTip('已重新铺好棋盘，点击「开始对战」即可开局。', 'ok')
  syncState()
}

/* ================= 设置项变更 ================= */
function readRounds() {
  gameState.endless = endlessChk.value
  if (gameState.endless) return 0
  let n = parseInt(roundInput.value, 10)
  if (!isFinite(n)) n = 1
  n = Math.max(1, Math.min(999, n))
  roundInput.value = n
  return n
}
function clampSizeInput() {
  let n = parseInt(sizeInput.value, 10)
  if (!isFinite(n)) n = gameState.side
  n = Math.max(5, Math.min(17, n))
  sizeInput.value = n
  return n
}
function applySize() {
  gameState.side = clampSizeInput()
}
function redrawForSetup() {
  applySize()
  if (roundAuto.value) roundInput.value = suggestRounds(gameState.side)
  gameState.totalRounds = readRounds()
  gameState.phase = 'ready'
  gameState.turnNo = 1
  gameState.log = []
  gameState.undoStack = []
  previewSet.value = new Set()
  changedNow.value = {}
  redrawBoard()
  resetTimer()
  clearMsg()
}
function onRedraw() {
  if (gameState.phase === 'playing') return
  gameState.totalRounds = readRounds()
  redrawForSetup()
  const k = extraOnBoard.value.length
  syncState()
  flashTip(`已重新抽取 ${cellTotal.value} 字棋盘（${gameState.side}×${gameState.side}${k ? `，含额外字 ${k}` : ''}），随时可以开局。`, 'ok')
}
function startGame() {
  if (gameState.phase === 'playing') return
  gameState.totalRounds = readRounds()
  /* 改了尺寸但没触发 change：先按新尺寸重铺，否则会拿旧棋盘开局 */
  const n = clampSizeInput()
  if (n !== gameState.side) {
    gameState.side = n
    redrawBoard()
  }
  gameState.phase = 'playing'
  gameState.turnNo = 1
  gameState.log = []
  gameState.undoStack = []
  previewSet.value = new Set()
  resetTimer()
  flashTip(
    gameState.endless
      ? '开局（战至最后一刻）！由 赤营 先飞。棋盘填满或点「提前结算」时结算。'
      : '开局！由 赤营 先飞。每句必须至少用一个未涂色的命中格。',
    'ok'
  )
  focusPoem()
  syncState()
}
function onSizeChange() {
  const n = clampSizeInput()
  if (gameState.phase === 'playing') return /* 对局中改尺寸不生效，只影响下一局 */
  if (n === gameState.side) return
  const roundWas = gameState.totalRounds
  redrawForSetup()
  const k = extraOnBoard.value.length
  flashTip(
    `棋盘已改为 ${gameState.side}×${gameState.side}（${cellTotal.value} 格${k ? `，含额外字 ${k}` : ''}），已重铺。` +
      (!gameState.endless && gameState.totalRounds !== roundWas ? `轮数按建议改为 ${gameState.totalRounds} 轮。` : ''),
    'ok'
  )
  syncState()
}
function onExtraChange() {
  if (gameState.phase === 'playing') {
    /* 对局中不生效，仅夹紧输入 */
    const cap = Math.min(cellTotal.value, EXTRA.length)
    extraInput.value = Math.max(0, Math.min(cap, parseInt(extraInput.value, 10) || 0))
    return
  }
  const k = parseInt(extraInput.value, 10) || 0
  redrawForSetup()
  syncState()
  flashTip(k ? `已重铺棋盘：其中 ${k} 个额外字（按唐诗频次加权抽取）。` : '已重铺棋盘：关闭额外字，只用基础 300 字。', 'ok')
}
function onRoundChange() {
  if (gameState.phase === 'playing') return
  gameState.totalRounds = readRounds()
  roundAuto.value = gameState.totalRounds === suggestRounds(gameState.side)
  if (roundAuto.value) flashTip(`轮数已回到建议值 ${gameState.totalRounds} 轮，之后改棋盘尺寸会自动跟着调。`, 'ok')
  syncState()
}
function onEndlessChange() {
  if (gameState.phase === 'playing') return
  readRounds()
  flashTip(
    gameState.endless
      ? '已切到战至最后一刻：不限轮数，棋盘填满或点「提前结算」才结束。'
      : `已回到有限轮数：${gameState.totalRounds} 轮。`,
    'ok'
  )
  syncState()
}
function onFinish() {
  if (confirm('确认提前结算？')) {
    finish()
    syncState()
  }
}

/* ================= 计时器 ================= */
const timerLeft = ref(30)
const timerRun = ref(false)
const timerSel = ref(30)
let timerId = null
function resetTimer() {
  stopTimer()
  timerLeft.value = parseInt(timerSel.value, 10) || 30
}
function startTimer() {
  if (timerRun.value) {
    stopTimer()
    return
  }
  timerRun.value = true
  timerId = setInterval(() => {
    timerLeft.value--
    if (timerLeft.value <= 0) {
      timerLeft.value = 0
      stopTimer()
    }
  }, 1000)
}
function stopTimer() {
  if (timerId) {
    clearInterval(timerId)
    timerId = null
  }
  timerRun.value = false
}

/* ================= 输入框交互 ================= */
const poemEl = ref(null)
function focusPoem() {
  nextTick(() => poemEl.value && poemEl.value.focus())
}
function onPoemInput() {
  updatePreview()
  clearMsg()
}
function onPoemKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    submitLine()
  }
}
function onPoemMousedown(e) {
  if (gameState.phase !== 'playing') {
    e.preventDefault() /* 不给焦点，只弹指引 */
    lockHint()
  }
}
function lockHint() {
  if (gameState.phase === 'over') {
    flashTip('本局已结束。点结算面板里的「再来一局」，或用「重抽棋盘」开新的一局。', 'warn')
  } else {
    flashTip('输入框还没解锁——请先点上方「开始对战」，之后即可输入诗句。', 'warn')
  }
}

/* ================= 启动 ================= */
onMounted(async () => {
  try {
    const me = await ensureAuth()
    uid.value = me.uid
    fbStatus.value = 'ok'
  } catch (e) {
    fbStatus.value = 'error'
    fbError.value = e.message
  }
  /* 断线重连：sessionStorage 记住了房间码就直接回到房间 */
  const saved = sessionStorage.getItem('fh_room')
  if (saved && uid.value) {
    try {
      const snap = await rtdbGet(`rooms/${saved}`)
      if (snap) enterRoom(saved)
      else sessionStorage.removeItem('fh_room')
    } catch (e) {
      sessionStorage.removeItem('fh_room')
    }
  }
  roundInput.value = suggestRounds(gameState.side)
  redrawBoard()
  resetTimer()
})
onBeforeUnmount(() => {
  if (timerId) clearInterval(timerId)
  if (changedTimer) clearTimeout(changedTimer)
  window.removeEventListener('resize', sizeCellFont)
  stopPolling()
})
onMounted(() => window.addEventListener('resize', sizeCellFont))
</script>

<template>
  <div class="wrap">
    <header class="top">
      <h1>飞花斯普拉遁<span class="tag">主持台</span></h1>
      <div class="head-tools">
        <span class="conn" :class="fbStatus" :title="fbError || connText"><i></i>{{ connText }}</span>
        <span v-if="roomState === 'playing'" class="conn room">房间 {{ roomCode }}</span>
        <span v-if="roomState === 'playing'" class="conn room">你是{{ myTeam ? TEAM_NAME[myTeam] : '观战' }}</span>
        <template v-if="roomState === 'playing'">
          <label class="chk" title="开启后，点击棋盘格子可循环切换：无主 → 赤 → 青 → 无主">
            <input type="checkbox" v-model="fixMode" :disabled="!isHost" /> 修正模式
          </label>
          <label class="sizefield" :class="{ off: gameState.phase === 'playing' }"
                 title="棋盘 N×N（5–17，上限受 300 字基础字库限制；改完自动重抽棋盘）">
            <input type="number" v-model.number="sizeInput" min="5" max="17" step="1" inputmode="numeric"
                   :disabled="gameState.phase === 'playing' || !isHost" @change="onSizeChange" />
            <span>× <b>{{ gameState.side }}</b> 格</span>
          </label>
          <label class="sizefield" :class="{ off: gameState.phase === 'playing' }"
                 title="额外字：从一级字表按唐诗频次加权抽取 K 个放进棋盘（0 = 只用基础 300 字）">
            <input type="number" v-model.number="extraInput" min="0" max="289" step="1" inputmode="numeric"
                   :disabled="gameState.phase === 'playing' || !isHost" @change="onExtraChange" />
            <span>个额外字</span>
          </label>
          <label class="sizefield" :class="{ off: gameState.phase === 'playing' || gameState.endless }"
                 title="对战轮数（每轮双方各飞一句）；改棋盘尺寸时自动给建议值">
            <input type="number" v-model.number="roundInput" min="1" max="999" step="1" inputmode="numeric"
                   :disabled="gameState.phase === 'playing' || gameState.endless || !isHost" @change="onRoundChange" />
            <span>轮</span>
          </label>
          <label class="chk" :class="{ off: gameState.phase === 'playing' }"
                 title="战至最后一刻：不限轮数，直到棋盘填满或点「提前结算」才结算">
            <input type="checkbox" v-model="endlessChk" :disabled="gameState.phase === 'playing' || !isHost" @change="onEndlessChange" /> 战至最后一刻
          </label>
          <button :disabled="gameState.phase === 'playing' || !isHost" @click="onRedraw">重抽棋盘</button>
          <button class="primary" :disabled="gameState.phase !== 'ready' || !isHost" @click="startGame">{{ startLabel }}</button>
          <button :disabled="!gameState.undoStack.length" @click="undo">撤销一步</button>
          <button :disabled="gameState.phase !== 'playing'" @click="onFinish">提前结算</button>
          <button @click="exitRoom">退出房间</button>
        </template>
      </div>
    </header>

    <!-- ========== 房间大厅 ========== -->
    <div v-if="roomState === 'lobby'" class="lobby">
      <div class="card">
        <div class="pad">
          <p class="sec-title">联机对战</p>
          <div class="lobby-status" :class="fbStatus">{{ lobbyStatusText }}</div>
          <div v-if="lobbyMsg" class="msg" :class="lobbyMsg.kind">{{ lobbyMsg.text }}</div>
          <button class="primary big" :disabled="roomBusy || !uid" @click="createRoom">创建房间</button>
          <div class="row joinrow">
            <input type="text" v-model="joinCode" placeholder="输入 6 位房间码" maxlength="6" @keyup.enter="joinRoom" />
            <button :disabled="roomBusy || !uid" @click="joinRoom">加入房间</button>
          </div>
          <p v-if="uid" class="uidline">匿名 UID：{{ uid }}</p>
        </div>
      </div>
    </div>

    <!-- ========== 游戏主界面 ========== -->
    <div v-else class="layout">
      <div v-if="hostOffline" class="banner">房主已离线，对战暂停 —— 等待房主回来后再继续。</div>
      <!-- 左：棋盘 -->
      <div class="side">
        <div class="card">
          <div class="pad turnbar">
            <div class="roundinfo">
              第 <b>{{ currentRound }}</b><template v-if="!gameState.endless"> / <b>{{ gameState.totalRounds }}</b></template> 轮<template v-if="gameState.endless"> · 战至最后一刻</template> · <span>{{ phaseText }}</span>
            </div>
            <div class="teams">
              <div class="team tA" :class="{ active: gameState.phase === 'playing' && currentTeam === 'A' }">
                <span class="swatch"></span>赤营 <span class="num">{{ score.a }}</span>
              </div>
              <div class="team tB" :class="{ active: gameState.phase === 'playing' && currentTeam === 'B' }">
                <span class="swatch"></span>青营 <span class="num">{{ score.b }}</span>
              </div>
            </div>
          </div>
          <div class="pad" style="padding-top:0">
            <div class="scorebar">
              <span class="seg-a" :style="{ width: ((score.a / cellTotal) * 100).toFixed(2) + '%' }"></span>
              <span class="seg-b" :style="{ width: ((score.b / cellTotal) * 100).toFixed(2) + '%' }"></span>
            </div>
            <div class="scorelegend">
              <span><i class="k-a"></i>赤营 <b>{{ score.a }}</b> 格</span>
              <span><i class="k-b"></i>青营 <b>{{ score.b }}</b> 格</span>
              <span><i class="k-n"></i>空白 <b>{{ score.n }}</b> 格</span>
              <span>已出手 <b>{{ flyTurns }}</b> 句</span>
            </div>
          </div>
          <div class="boardwrap">
            <div ref="boardEl" class="board" :style="boardStyle">
              <div v-for="(cell, idx) in gameState.board" :key="idx" :class="cellClass(idx)" @click="onCellClick(idx)">
                {{ cell.ch }}
              </div>
            </div>
          </div>

          <details>
            <summary>字库（《全唐诗》字频前 300）</summary>
            <div class="detbody">
              <div class="poolgrid">
                <span v-for="ch in POOL" :key="ch" :class="{ on: poolOn[ch] }">{{ ch }}</span>
              </div>
            </div>
          </details>
          <details>
            <summary>{{ extraOnBoard.length ? `额外字（本局 ${extraOnBoard.length} 个）` : `额外字（本局未启用 · 共 ${EXTRA.length} 字可选）` }}</summary>
            <div class="detbody">
              <div class="poolgrid">
                <span v-for="ch in extraOnBoard" :key="ch" class="on" :title="`唐诗出现 ${EXTRA_FREQ[ch] || 0} 次`">{{ ch }}</span>
              </div>
              <p v-if="!extraOnBoard.length" class="poolnote">
                本局未启用额外字。在顶栏「额外字」填一个数字，就能让其中若干格改从一级字池里抽（按唐诗出现频次加权）。
              </p>
            </div>
          </details>
          <details>
            <summary>规则与判定逻辑</summary>
            <div class="detbody">
              <ol class="rules">
                <li>棋盘：从《全唐诗》字频前 300 中<b>随机抽 N×N 个不重复的字</b>铺成方阵（N 可在顶栏设 5–17）。顶栏「<b>额外字</b>」可指定其中 K 格改从<b>额外字池</b>里抽 —— 抽取<b>按唐诗出现频次加权</b>，越常见的字越容易被抽中。</li>
                <li>涂色：某人飞出一句后，<b>诗句中所有出现在棋盘上的字</b>，对应格子全部涂成该方颜色。</li>
                <li>合法性：本句命中棋盘的字中，<b>至少要有 1 个格子当前未填色</b>；命中已涂色格可以抢夺。若命中格全都是已有颜色，本句无效。</li>
                <li>胜负：满设定轮数（双方各飞相同句数）后结算，<b>己方颜色格子多者胜</b>；等同则平局。<b>棋盘提前被填满时立即结算</b>；选「<b>战至最后一刻</b>」时不限轮数，只有棋盘填满或点「提前结算」才结算。</li>
              </ol>
            </div>
          </details>
        </div>
      </div>

      <!-- 右：主持操作台 -->
      <div class="side">
        <div class="card">
          <div class="pad">
            <p class="sec-title">当前出手方</p>
            <div class="teams" style="margin-bottom:12px">
              <div class="team tA" :class="{ active: gameState.phase === 'playing' && currentTeam === 'A' }">
                <span class="swatch"></span>赤营
              </div>
              <div class="team tB" :class="{ active: gameState.phase === 'playing' && currentTeam === 'B' }">
                <span class="swatch"></span>青营
              </div>
            </div>
            <p class="sec-title">录入诗句</p>
            <textarea ref="poemEl" v-model="poemInput" :readonly="poemLocked"
                      :class="{ locked: poemLocked }" maxlength="50"
                      :placeholder="poemPlaceholder"
                      @input="onPoemInput" @mousedown="onPoemMousedown" @keydown="onPoemKeydown"></textarea>
            <div class="timer">
              <div class="clock" :class="{ run: timerRun, low: timerRun && timerLeft <= 10 }">{{ timerLeft }}</div>
              <div class="row">
                <button :disabled="gameState.phase !== 'playing'" @click="startTimer">{{ timerRun ? '暂停' : '开始计时' }}</button>
                <button :disabled="gameState.phase !== 'playing'" @click="resetTimer">复位</button>
                <select v-model.number="timerSel" @change="!timerRun && resetTimer()">
                  <option :value="15">15 秒</option>
                  <option :value="20">20 秒</option>
                  <option :value="30">30 秒</option>
                  <option :value="45">45 秒</option>
                  <option :value="60">60 秒</option>
                </select>
              </div>
            </div>
            <div class="row" style="margin-top:12px">
              <button class="primary submit" :class="currentTeam === 'A' ? 'team-a' : 'team-b'"
                      :disabled="gameState.phase !== 'playing' || !myTurn || hostOffline || poetryBusy" @click="submitLine">
                {{ poetryBusy ? '校验诗句中…' : myTurn ? '提交飞花（回车）' : '等待对方出牌...' }}
              </button>
              <button :disabled="gameState.phase !== 'playing' || !myTurn || hostOffline" @click="passTurn">放弃本回合</button>
            </div>
            <label class="chk" style="margin-top:10px;display:flex">
              <input type="checkbox" v-model="allowDup" /> 允许重复句（默认拦截已出现过的句子）
            </label>
            <label class="chk" style="margin-top:8px;display:flex"
                   title="记录里如何显示诗句：默认把标点等非文字符号折成一个空格；勾选后原样保留你输入的标点">
              <input type="checkbox" v-model="keepPunct" /> 保留输入标点（默认把标点折成空格）
            </label>
            <div v-if="msg" class="msg" :class="msg.kind">{{ msg.text }}</div>
          </div>
        </div>

        <div class="card">
          <div class="pad" style="padding-bottom:4px">
            <p class="sec-title" style="margin-bottom:2px">飞花记录</p>
          </div>
          <div class="pad" style="padding-top:6px">
            <ul class="loglist">
              <li v-for="e in flyLogs" :key="e.round + '-' + e.team" :class="e.team === 'A' ? 'tA' : 'tB'">
                <span class="badge" :class="e.team === 'A' ? 'bA' : 'bB'" :title="TEAM_NAME[e.team]">{{ TEAM_MARK[e.team] }}</span>
                <div class="body">
                  <template v-if="e.type === 'pass'">
                    <div class="line" style="color:#5B6B84">—— 放弃本回合 ——</div>
                    <div class="meta">第 {{ e.round }} 轮 · 未涂色</div>
                  </template>
                  <template v-else>
                    <div class="line">
                      <template v-for="(seg, si) in poemSegs(e)" :key="si">
                        <u v-if="seg.kind" class="mk" :class="'mk-' + seg.kind">{{ seg.text }}</u>
                        <template v-else>{{ seg.text }}</template>
                      </template>
                      <span v-if="e.meta" class="src"> —— {{ e.meta }}</span>
                    </div>
                    <div class="meta">
                      第 {{ e.round }} 轮 · 命中 <b>{{ e.hits }}</b> 格 ｜
                      <em :class="e.team === 'A' ? 'em-a' : 'em-b'">新占 {{ e.blank }}</em> ·
                      <em :class="e.team === 'A' ? 'em-a' : 'em-b'">抢夺 {{ e.capture }}</em> ·
                      己方 {{ e.hold }}
                    </div>
                  </template>
                </div>
              </li>
            </ul>
            <div v-if="!flyLogs.length" class="empty">尚未开始，记录会显示在这里。</div>
          </div>
        </div>
      </div>
    </div>

    <!-- ========== 结算弹窗 ========== -->
    <div v-if="showResult" class="overlay" @click.self="showResult = false">
      <div class="modal">
        <div class="winner">{{ resultInfo.label }}</div>
        <div class="winname" :style="{ color: resultInfo.color }">{{ resultInfo.win }} ｜ {{ resultInfo.name }}</div>
        <div class="final">
          <div class="fbox"><div class="fv" style="color:var(--ink-a)">{{ score.a }}</div><div class="fk">赤营格子</div></div>
          <div class="fbox"><div class="fv" style="color:var(--ink-b)">{{ score.b }}</div><div class="fk">青营格子</div></div>
          <div class="fbox"><div class="fv" style="color:#5B6B84">{{ score.n }}</div><div class="fk">未被涂色</div></div>
        </div>
        <div class="statgrid">
          <div>赤营出手 <b>{{ flyCount('A') }} 句</b></div>
          <div>青营出手 <b>{{ flyCount('B') }} 句</b></div>
          <div>双方抢夺合计 <b>{{ capTotal() }} 格</b></div>
        </div>
        <h3>飞句全记录</h3>
        <div class="poembox">
          <p v-if="!resultFlies.length" style="color:#5B6B84">本局没有有效飞句。</p>
          <p v-for="(e, i) in resultFlies" :key="i" :class="e.team === 'A' ? 'tA' : 'tB'">
            <span class="tagt" :style="{ color: e.team === 'A' ? 'var(--ink-a)' : 'var(--ink-b)' }">{{ TEAM_NAME[e.team] }}</span><template v-for="(seg, si) in poemSegs(e)" :key="si"><u v-if="seg.kind" class="mk" :class="'mk-' + seg.kind">{{ seg.text }}</u><template v-else>{{ seg.text }}</template></template><span style="color:#5B6B84">　（命中{{ e.hits }}／新占{{ e.blank }}／抢{{ e.capture }}）</span>
          </p>
        </div>
        <div class="row" style="margin-top:16px;justify-content:flex-end">
          <button @click="showResult = false">返回棋盘</button>
          <button class="primary" :disabled="!isHost" title="仅房主可开新局" @click="again">再来一局</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.wrap{max-width:1240px;margin:0 auto;padding:20px 20px 56px;}

/* ---------- header ---------- */
header.top{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;flex-wrap:nowrap;margin-bottom:16px;}
h1{font-size:22px;margin:0;letter-spacing:.5px;white-space:nowrap;flex:0 0 auto;}
h1 .tag{font-size:12px;font-weight:600;vertical-align:middle;margin-left:8px;background:#E8EEF8;color:#2C4A78;border-radius:999px;padding:3px 9px;letter-spacing:0;}
.head-tools{display:flex;gap:4px;align-items:center;flex-wrap:nowrap;justify-content:flex-end;min-width:0;}
.head-tools>*{flex:0 0 auto;}
header.top button{padding:7px 9px;white-space:nowrap;}
@media (max-width:1159px){ header.top{flex-wrap:wrap;} }

/* 连接状态 chip */
.conn{display:inline-flex;align-items:center;gap:6px;font-size:12px;border-radius:999px;padding:4px 10px;border:1px solid var(--line);background:#fff;color:var(--muted);}
.conn i{width:8px;height:8px;border-radius:50%;background:#9AA7BA;}
.conn.ok{color:#1B6B36;background:#E9F6ED;border-color:#9BD3AC;}
.conn.ok i{background:#2E9E5B;}
.conn.error{color:var(--danger);background:#FDEDEB;border-color:#F6CFCA;}
.conn.error i{background:var(--danger);}
.conn.lost{color:#8A5A0B;background:#FFF6E6;border-color:#F4DEB2;}
.conn.lost i{background:#C98A1B;}
.conn.room{background:#E8EEF8;color:#2C4A78;font-weight:700;border-color:#C7D7EE;}

/* ---------- generic controls ---------- */
button{font-family:inherit;font-size:13px;font-weight:600;cursor:pointer;border-radius:10px;border:1px solid var(--line);background:#fff;color:var(--text);padding:8px 14px;transition:.15s;line-height:1.2;}
button:hover:not(:disabled){border-color:#B9C6DA;background:#FAFBFE;}
button:disabled{opacity:.45;cursor:not-allowed;}
button.primary{background:var(--ink-b);border-color:var(--ink-b);color:#fff;}
button.primary:hover:not(:disabled){background:#175E9E;}
button.danger{background:var(--ink-a);border-color:var(--ink-a);color:#fff;}
button.danger:hover:not(:disabled){background:#A72C22;}
button.big{width:100%;padding:12px;font-size:15px;}
/* 提交按钮跟随当前回合方墨色 */
.submit.team-a{background:var(--ink-a);border-color:var(--ink-a);color:#fff;}
.submit.team-a:hover:not(:disabled){background:#A72C22;}
.submit.team-b{background:var(--ink-b);border-color:var(--ink-b);color:#fff;}
.submit.team-b:hover:not(:disabled){background:#175E9E;}
select,input[type=text],input[type=number]{font-family:inherit;font-size:13px;padding:8px 10px;border:1px solid var(--line);border-radius:10px;background:#fff;color:var(--text);}
.sizefield{display:inline-flex;align-items:center;gap:5px;font-size:12px;color:var(--muted);}
.sizefield input{width:50px;padding:7px 4px;text-align:center;font-variant-numeric:tabular-nums;}
.sizefield b{color:var(--text);font-variant-numeric:tabular-nums;}
input[type=number]:disabled,select:disabled{background:#F2F5FA;border-color:#E1E7F0;color:#7A8698;cursor:not-allowed;-webkit-text-fill-color:#7A8698;opacity:1;}
.sizefield.off,.sizefield.off b,.chk.off{color:#7A8698;}
.chk input:disabled{cursor:not-allowed;}
.chk{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--muted);cursor:pointer;user-select:none;}
.chk input{accent-color:var(--ink-b);width:14px;height:14px;}

/* ---------- 大厅 ---------- */
.lobby{max-width:430px;margin:40px auto 0;}
.lobby-status{border-radius:10px;padding:12px 14px;margin:4px 0 16px;font-size:14px;border:1px solid var(--line);background:var(--blank);color:var(--muted);}
.lobby-status.ok{background:#E9F6ED;border-color:#9BD3AC;color:#1B6B36;}
.lobby-status.error{background:#FDEDEB;border-color:#F6CFCA;color:var(--danger);}
.lobby-status.lost{background:#FFF6E6;border-color:#F4DEB2;color:#8A5A0B;}
.joinrow{margin-top:10px;}
.joinrow input{flex:1 1 auto;}
.uidline{margin:14px 0 0;font-size:12px;font-family:ui-monospace,Consolas,monospace;color:var(--muted);word-break:break-all;}

/* ---------- layout ---------- */
.layout{display:grid;grid-template-columns:minmax(0,1fr) 396px;gap:18px;align-items:start;}
@media (max-width:1080px){.layout{grid-template-columns:1fr;}}
.banner{grid-column:1/-1;background:#FFF6E6;border:1px solid #F4DEB2;color:#8A5A0B;border-radius:12px;padding:10px 16px;font-size:13px;font-weight:600;}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow);}
.card .pad{padding:14px 16px;}

/* ---------- turn / score ---------- */
.turnbar{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;}
.roundinfo{font-size:13px;color:var(--muted);}
.roundinfo b{color:var(--text);font-size:15px;}
.teams{display:flex;gap:8px;}
.team{display:flex;align-items:center;gap:8px;padding:7px 13px;border-radius:999px;border:2px solid var(--line);background:#fff;font-size:13px;font-weight:700;color:var(--muted);transition:.18s;}
.team .swatch{width:12px;height:12px;border-radius:4px;}
.team.tA .swatch{background:var(--ink-a);}
.team.tB .swatch{background:var(--ink-b);}
.team.tA.active{border-color:var(--ink-a);color:var(--ink-a);background:#FCF0EE;box-shadow:0 0 0 4px rgba(194,53,42,.08);}
.team.tB.active{border-color:var(--ink-b);color:var(--ink-b);background:#EDF4FB;box-shadow:0 0 0 4px rgba(30,111,184,.08);}
.team .num{font-variant-numeric:tabular-nums;font-size:15px;}
.scorebar{height:12px;border-radius:999px;overflow:hidden;display:flex;background:var(--blank);margin-top:12px;border:1px solid var(--line);}
.scorebar span{display:block;height:100%;transition:width .35s cubic-bezier(.4,0,.2,1);}
.seg-a{background:var(--ink-a);}
.seg-b{background:var(--ink-b);}
.scorelegend{display:flex;gap:16px;flex-wrap:wrap;font-size:12px;color:var(--muted);margin-top:8px;}
.scorelegend i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:5px;vertical-align:-1px;}
.k-a{background:var(--ink-a);}.k-b{background:var(--ink-b);}.k-n{background:var(--blank);border:1px solid var(--line);}
.scorelegend b{color:var(--text);font-variant-numeric:tabular-nums;}

/* ---------- board ---------- */
.boardwrap{padding:14px;}
/* 无缝网格：gap=0，靠每格 1px 边框画格线；同色相邻格的边框设为透明，墨块连成整片 */
.board{display:grid;gap:0;background:#fff;padding:0;border:1px solid var(--grid);border-radius:12px;overflow:hidden;}
.cell{aspect-ratio:1/1;display:flex;align-items:center;justify-content:center;background:var(--blank);color:var(--blank-text);border-right:1px solid var(--grid);border-bottom:1px solid var(--grid);font-size:var(--cell-fs,27px);font-weight:600;line-height:1;position:relative;user-select:none;border-radius:0;transition:background .18s,color .18s,box-shadow .18s;}
.cell.nb-r{border-right-color:transparent;}
.cell.nb-b{border-bottom-color:transparent;}
.cell.own-A{background:var(--ink-a);color:#fff;}
.cell.own-B{background:var(--ink-b);color:#fff;}
/* 出手前预览：命中且未填色 → 半透明填充+实线内框；敌格 → 半透明墨色+虚线框；己方格 → 白内框 */
.cell.pv-A.pv-new{background:var(--pv-a);color:var(--blank-text);box-shadow:inset 0 0 0 3px var(--ink-a);}
.cell.pv-B.pv-new{background:var(--pv-b);color:var(--blank-text);box-shadow:inset 0 0 0 3px var(--ink-b);}
.cell.pv-A.pv-cap{background:var(--pv-ab);color:#fff;outline:2px dashed var(--ink-a);outline-offset:-3px;}
.cell.pv-B.pv-cap{background:var(--pv-ba);color:#fff;outline:2px dashed var(--ink-b);outline-offset:-3px;}
.cell.pv-A.pv-hold,.cell.pv-B.pv-hold{box-shadow:inset 0 0 0 3px rgba(255,255,255,.62);}
/* 本手刚变化的格子：白色内描边 */
.cell.flash::after{content:"";position:absolute;inset:0;box-sizing:border-box;border:3px solid rgba(255,255,255,.95);pointer-events:none;animation:flashRing 1.05s ease-out forwards;}
@keyframes flashRing{0%{opacity:0;}10%{opacity:1;}72%{opacity:1;}100%{opacity:0;}}
.cell.fixable{cursor:pointer;}
.cell.fixable:hover{filter:brightness(.9);}

/* ---------- side ---------- */
.side{display:flex;flex-direction:column;gap:14px;}
.sec-title{font-size:12px;font-weight:700;letter-spacing:1.2px;color:var(--muted);text-transform:uppercase;margin:0 0 10px;}
textarea{width:100%;min-height:64px;resize:vertical;font-family:inherit;font-size:17px;letter-spacing:1px;line-height:1.5;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:#FBFCFE;color:var(--text);}
textarea:focus{outline:none;border-color:var(--ink-b);box-shadow:0 0 0 3px rgba(30,111,184,.12);background:#fff;}
textarea.locked{background:#F1F4F9;border-color:#E4EAF3;cursor:pointer;}
textarea.locked:focus{border-color:var(--line);box-shadow:none;background:#F1F4F9;}
textarea.locked::placeholder{color:#6B7889;}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}
.msg{font-size:12.5px;margin-top:9px;padding:8px 10px;border-radius:9px;line-height:1.5;}
.msg.ok{background:#EAF6EF;color:#1E6B45;border:1px solid #C6E7D4;}
.msg.warn{background:#FFF6E6;color:#8A5A0B;border:1px solid #F4DEB2;}
.msg.err{background:#FDEDEB;color:#98271D;border:1px solid #F6CFCA;}

/* timer */
.timer{display:flex;align-items:center;gap:10px;margin-top:10px;}
.clock{font-size:24px;font-weight:700;font-variant-numeric:tabular-nums;letter-spacing:.5px;min-width:64px;text-align:center;padding:2px 10px;border-radius:9px;background:#F1F4F9;color:var(--text);}
.clock.run{background:#EDF4FB;color:var(--ink-b);}
.clock.low{background:#FDEDEB;color:var(--ink-a);}

/* log */
.loglist{list-style:none;margin:0;padding:0;max-height:340px;overflow:auto;}
.loglist li{display:flex;gap:9px;padding:8px 4px;border-bottom:1px dashed #EAEFF7;font-size:13px;align-items:flex-start;}
.loglist li:last-child{border-bottom:0;}
.loglist .badge{flex:0 0 auto;width:22px;height:22px;border-radius:7px;color:#fff;font-size:12.5px;font-weight:700;display:flex;align-items:center;justify-content:center;margin-top:1px;}
.bA{background:var(--ink-a);}.bB{background:var(--ink-b);}
.loglist .body{flex:1 1 auto;min-width:0;}
.loglist .line{font-size:14.5px;letter-spacing:.5px;word-break:break-all;}
/* 诗句里命中的字：新占＝墨黑实线 / 抢夺＝己方笔色实线 / 己方＝中性灰点状线 */
.mk{text-decoration-line:underline;text-decoration-thickness:2px;text-underline-offset:4px;text-decoration-skip-ink:none;-webkit-text-decoration-skip-ink:none;}
.mk-new{text-decoration-color:var(--text);}
.mk-cap{text-decoration-color:var(--ink-a);}
.tB .mk-cap{text-decoration-color:var(--ink-b);}
.mk-hold{text-decoration-style:dotted;text-decoration-color:var(--hit-hold);}
.loglist .meta{font-size:11.5px;color:var(--muted);margin-top:2px;}
.loglist .meta em{font-style:normal;font-weight:700;}
.loglist .line .src{color:#5B6B84;font-size:12px;margin-left:2px;}
.em-a{color:var(--ink-a);}.em-b{color:var(--ink-b);}
.empty{font-size:12.5px;color:var(--muted);text-align:center;padding:18px 0;}

details{border-top:1px solid var(--line);}
details summary{cursor:pointer;font-size:12.5px;font-weight:600;color:var(--muted);padding:10px 16px;list-style:none;}
details summary::-webkit-details-marker{display:none;}
details summary:before{content:"▸ ";color:var(--muted);}
details[open] summary:before{content:"▾ ";}
details .detbody{padding:0 16px 14px;font-size:12.5px;color:var(--muted);}
.poolnote{margin:8px 0 0;font-size:12px;line-height:1.7;color:var(--muted);}
.poolgrid{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px;}
.poolgrid span{width:24px;height:24px;display:flex;align-items:center;justify-content:center;border-radius:6px;background:#F4F7FB;font-size:13px;color:var(--muted);}
.poolgrid span.on{background:#E4EDF9;color:#1E4E86;font-weight:700;box-shadow:0 0 0 1px #B9D2EC inset;}
ol.rules{margin:6px 0 0 18px;padding:0;}
ol.rules li{margin-bottom:5px;line-height:1.6;}

/* ---------- result ---------- */
.overlay{position:fixed;inset:0;background:rgba(23,35,54,.55);backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;padding:20px;z-index:50;}
.modal{background:#fff;border-radius:18px;max-width:720px;width:100%;max-height:88vh;overflow:auto;padding:26px 26px 20px;box-shadow:0 24px 60px rgba(12,24,44,.28);}
.winner{font-size:13px;font-weight:700;letter-spacing:2px;color:var(--muted);}
.winname{font-size:30px;font-weight:800;margin:4px 0 16px;letter-spacing:2px;}
.final{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:18px;}
.final .fbox{border:1px solid var(--line);border-radius:12px;padding:12px;text-align:center;background:#FBFCFE;}
.fbox .fv{font-size:28px;font-weight:800;font-variant-numeric:tabular-nums;line-height:1.15;}
.fbox .fk{font-size:12px;color:var(--muted);margin-top:2px;}
.statgrid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;font-size:12.5px;margin-bottom:16px;}
.statgrid div{background:#F5F8FC;border-radius:9px;padding:8px 10px;}
.statgrid b{display:block;font-size:15px;font-variant-numeric:tabular-nums;}
.modal h3{font-size:13px;letter-spacing:1px;color:var(--muted);margin:0 0 8px;text-transform:uppercase;}
.poembox{max-height:220px;overflow:auto;border:1px solid var(--line);border-radius:10px;padding:10px 12px;background:#FBFCFE;font-size:13px;}
.poembox p{margin:0 0 7px;line-height:1.6;}
.poembox .tagt{font-weight:700;margin-right:6px;}
</style>
