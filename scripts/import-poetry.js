/* 阶段一：chinese-poetry 数据集清洗 → D1 导入 SQL
   用法：node scripts/import-poetry.js [数据集目录=chinese-poetry] [输出文件=poetry_init.sql]
   注：不做去重 —— 同一句可出自多首诗（含集句诗），全部保留各自的作者/诗名/朝代 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Buffer } from 'node:buffer'
import OpenCC from 'opencc-js'

const DATA_DIR = process.argv[2] || 'chinese-poetry'
const OUT_FILE = process.argv[3] || 'poetry_init.sql'
const MAX_STMT_BYTES = 64 * 1024 // 单条 INSERT 字节上限（D1 语句上限 100KB，留余量）
const MIN_LEN = 4
const MAX_LEN = 30
/* 汉字范围与前端 cjkOnly 一致（仅 CJK 基本区），保证词库句子能被玩家输入命中 */
const NON_HAN = /[^\u4E00-\u9FA5]+/

const t2s = OpenCC.Converter({ from: 't', to: 'cn' })

function listJsonFiles(dir) {
  const out = []
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, name.name)
    if (name.isDirectory()) out.push(...listJsonFiles(p))
    else if (name.isFile() && name.name.toLowerCase().endsWith('.json')) out.push(p)
  }
  return out
}

const esc = (s) => String(s).replace(/'/g, "''")

/* 一首诗 → 若干纯汉字单句：繁转简 → 按非汉字字符切段 → 长度过滤 */
function extractSentences(entry) {
  if (!entry || !Array.isArray(entry.paragraphs)) return []
  const text = t2s(entry.paragraphs.join('\n'))
  return text.split(NON_HAN).filter((s) => s.length >= MIN_LEN && s.length <= MAX_LEN)
}

const files = listJsonFiles(DATA_DIR)
console.log(`发现 JSON 文件 ${files.length} 个，开始清洗…`)

let poemCount = 0
let rawSentences = 0
let parseErrors = 0

const lines = [
  'CREATE TABLE IF NOT EXISTS poetry (',
  '  id INTEGER PRIMARY KEY,',
  '  sentence TEXT NOT NULL,',
  '  author   TEXT,',
  '  title    TEXT,',
  '  dynasty  TEXT',
  ');',
  'CREATE INDEX IF NOT EXISTS idx_poetry_sentence ON poetry(sentence);',
]

/* 流式写入：按字节预算合并行，减少 INSERT 语句条数（远程导入更快） */
const STMT_PREFIX = 'INSERT INTO poetry (sentence, author, title, dynasty) VALUES '
let buf = ''
let rowCount = 0
let insertCount = 0
const flush = () => {
  if (!rowCount) return
  lines.push(STMT_PREFIX + buf + ';')
  insertCount++
  buf = ''
  rowCount = 0
}
/* 完全相同四元组（同句+同作者+同诗名+同朝代）只保留一条：同一首诗被多本选本收录时去重，
   不同来源（集句诗等）的重复句不受影响 */
const seen = new Set()
let dupCount = 0
const addRow = (row) => {
  const key = `${row.sentence}\u0001${row.author}\u0001${row.title}\u0001${row.dynasty}`
  if (seen.has(key)) {
    dupCount++
    return
  }
  seen.add(key)
  const v = `('${esc(row.sentence)}','${esc(row.author)}','${esc(row.title)}','${esc(row.dynasty)}')`
  if (rowCount && Buffer.byteLength(buf) + Buffer.byteLength(v) + 1 > MAX_STMT_BYTES) flush()
  buf += (rowCount ? ',' : '') + v
  rowCount++
}

for (let i = 0; i < files.length; i++) {
  let data
  try {
    data = JSON.parse(readFileSync(files[i], 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    parseErrors++
    continue
  }
  if (!Array.isArray(data)) continue
  for (const entry of data) {
    const sentences = extractSentences(entry)
    if (!sentences.length) continue
    poemCount++
    const author = t2s(entry.author || '')
    const title = t2s(entry.title || entry.section || entry.chapter || '')
    const dynasty = t2s(entry.dynasty || '')
    for (const s of sentences) {
      addRow({ sentence: s, author, title, dynasty })
      rawSentences++
    }
  }
  if ((i + 1) % 200 === 0) console.log(`  进度 ${i + 1}/${files.length} · 已写入 ${rawSentences} 句`)
}
flush()

writeFileSync(OUT_FILE, lines.join('\n'), 'utf8')
console.log(`处理诗词 ${poemCount} 首，原句 ${rawSentences} 条，剔除完全相同四元组 ${dupCount} 条，写入 ${rawSentences - dupCount} 句，解析失败 ${parseErrors} 个文件`)
console.log(`已生成 ${OUT_FILE}：CREATE TABLE + INDEX ×1 + INSERT ${insertCount} 条`)
