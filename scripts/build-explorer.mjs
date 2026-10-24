// Builds public/explorer/: how often players at each rating play each move in the opening, with their results,
// from the Lichess open database (CC0, https://database.lichess.org). The monthly file is streamed and never
// stored, and the script can stop after a number of games:
//
//   node --max-old-space-size=3072 scripts/build-explorer.mjs <url or .pgn.zst file> [--games 15000000] [--out public/explorer]
//
// Counting: every game's first PLIES moves, keyed by the moves so far and the rating band of the player making
// the move, with the game's result. Rare move orders are dropped as memory fills (lossy counting), which can only
// undercount lines that are rare anyway. Then each kept move order is replayed to its position, so move orders
// that transpose are merged, and the positions are written in shards by position key: the app fetches the one
// shard it needs for the position on the board.
import { Chess } from 'chess.js'
import { createReadStream, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { get } from 'node:https'
import { createInterface } from 'node:readline'
import { Transform } from 'node:stream'
import { createZstdDecompress } from 'node:zlib'
import { positionKey } from '../src/openingHash.ts'

const args = process.argv.slice(2)
const source = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'))
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback)
const MAX_GAMES = Number(option('--games', Infinity))
const OUT = option('--out', 'public/explorer')
const PLIES = Number(option('--plies', 20))
const MIN_GAMES = Number(option('--min', 20)) // a move is kept if this many games (all bands) played it
const SHARD_DIGITS = Number(option('--shard-digits', 2)) // 2 → 256 files
const LIMIT = Number(option('--limit', 5_000_000)) // counters kept in memory before rare ones are dropped
if (!source) throw new Error('usage: build-explorer.mjs <url or .pgn.zst file> [--games N] [--out dir]')

// Rating bands (Lichess ratings) of the player making the move
const BANDS = [1200, 1500, 1800, 2100] // <1200, 1200–1499, 1500–1799, 1800–2099, 2100+
const bandOf = (elo) => BANDS.filter((b) => elo >= b).length
const NB = BANDS.length + 1

// Moves are coded as one character each, so a move order is a short string
const codes = new Map()
const sans = []
const code = (san) => {
  let c = codes.get(san)
  if (c === undefined) {
    c = String.fromCharCode(0x100 + sans.length)
    codes.set(san, c)
    sans.push(san)
  }
  return c
}

// counter key: move order + band digit; value: index into counts (white wins, draws, black wins)
let index = new Map()
let counts = new Int32Array(3 * 1_000_000)
let used = 0
let dropped = 0 // the highest count a dropped counter had: counts can be low by at most the sum of these
let dropError = 0

function add(key, result) {
  let i = index.get(key)
  if (i === undefined) {
    i = used++
    if (3 * used > counts.length) {
      const bigger = new Int32Array(counts.length * 2)
      bigger.set(counts)
      counts = bigger
    }
    index.set(key, i)
  }
  counts[3 * i + result]++
}

function prune() {
  let threshold = 2
  for (;;) {
    let kept = 0
    for (const i of index.values()) if (counts[3 * i] + counts[3 * i + 1] + counts[3 * i + 2] >= threshold) kept++
    if (kept <= LIMIT / 2) break
    threshold *= 2
  }
  const nextIndex = new Map()
  const next = new Int32Array(Math.max(3 * (LIMIT + 1), 3 * 1_000_000))
  let n = 0
  for (const [key, i] of index) {
    const total = counts[3 * i] + counts[3 * i + 1] + counts[3 * i + 2]
    if (total < threshold) continue
    next.set(counts.subarray(3 * i, 3 * i + 3), 3 * n)
    nextIndex.set(key, n++)
  }
  index = nextIndex
  counts = next
  used = n
  dropped++
  dropError += threshold - 1
  console.log(`  dropped counters under ${threshold} games (${n} kept)`)
}

function speedOk(tc) {
  // Lichess speeds by estimated duration: skip bullet (and ultrabullet) and correspondence ("-")
  const [base, inc] = tc.split('+').map(Number)
  return Number.isFinite(base) && base + 40 * (inc || 0) >= 180
}

const RESULT = { '1-0': 0, '1/2-1/2': 1, '0-1': 2 }
let games = 0
let seen = 0
let headers = {}
const started = Date.now()

function onGame(movetext) {
  seen++
  const result = RESULT[headers.Result]
  const we = Number(headers.WhiteElo)
  const be = Number(headers.BlackElo)
  if (result === undefined || !we || !be || !headers.TimeControl || !speedOk(headers.TimeControl)) return
  const tokens = movetext.replace(/\{[^}]*\}/g, ' ').split(/\s+/)
  let key = ''
  let ply = 0
  for (const tok of tokens) {
    if (!tok || /^\d+\.+$/.test(tok) || tok.startsWith('$')) continue
    if (tok in RESULT || tok === '*') break
    key += code(tok.replace(/[?!]+$/, ''))
    add(key + String(bandOf(ply % 2 === 0 ? we : be)), result)
    if (++ply >= PLIES) break
  }
  if (ply === 0) return
  games++
  if (used > LIMIT) prune()
  if (games % 500_000 === 0) {
    const s = (Date.now() - started) / 1000
    console.log(`${games} games (${seen} read), ${index.size} counters, ${Math.round(games / s)} games/s`)
  }
}

async function input() {
  if (!/^https?:/.test(source)) return createReadStream(source)
  return new Promise((resolve, reject) =>
    get(source, (res) => (res.statusCode === 200 ? resolve(res) : reject(new Error(`HTTP ${res.statusCode}`)))).on('error', reject),
  )
}

/**
 * The Lichess files are written by pzstd: each zstd frame follows a skippable frame holding its compressed size.
 * Node's decompressor rejects skippable frames, so this drops them and passes the zstd frames through.
 */
function dropSkippableFrames() {
  let pending = Buffer.alloc(0)
  let passing = 0 // bytes of the current zstd frame still to pass through
  return new Transform({
    transform(chunk, _enc, done) {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk
      while (pending.length) {
        if (passing) {
          const n = Math.min(passing, pending.length)
          this.push(pending.subarray(0, n))
          pending = pending.subarray(n)
          passing -= n
          continue
        }
        if (pending.length < 12) break
        const magic = pending.readUInt32LE(0)
        if ((magic & 0xfffffff0) !== 0x184d2a50) {
          // not pzstd: plain zstd from here on
          this.push(pending)
          pending = Buffer.alloc(0)
          passing = Infinity
          break
        }
        const size = pending.readUInt32LE(4)
        if (pending.length < 8 + size) break
        passing = size === 4 ? pending.readUInt32LE(8) : 0
        pending = pending.subarray(8 + size)
      }
      done()
    },
  })
}

const raw = await input()
const stream = raw.pipe(dropSkippableFrames()).pipe(createZstdDecompress())
const lines = createInterface({ input: stream, crlfDelay: Infinity })
for await (const line of lines) {
  if (line.startsWith('[')) {
    const m = /^\[(\w+) "(.*)"\]$/.exec(line)
    if (m) headers[m[1]] = m[2]
  } else if (line.trim()) {
    onGame(line)
    headers = {}
    if (games >= MAX_GAMES) break
  }
}
raw.destroy()
console.log(`counted ${games} games (${seen} read) in ${Math.round((Date.now() - started) / 1000)} s; ${index.size} counters`)

// Merge the bands of each move order and keep the moves enough games played
const orders = new Map() // move order -> counts per band
for (const [key, i] of index) {
  const order = key.slice(0, -1)
  const band = Number(key.at(-1))
  let row = orders.get(order)
  if (!row) orders.set(order, (row = new Array(3 * NB).fill(0)))
  for (let r = 0; r < 3; r++) row[3 * band + r] += counts[3 * i + r]
}
index = null
counts = null
const kept = [...orders].filter(([, row]) => row.reduce((a, b) => a + b, 0) >= MIN_GAMES).sort((a, b) => (a[0] < b[0] ? -1 : 1))
console.log(`${kept.length} move orders with at least ${MIN_GAMES} games`)

// Replay them (in sorted order, so each extends the previous path) and merge by position
const positions = new Map() // position key -> Map(uci -> counts)
const chess = new Chess()
let path = ''
for (const [order, row] of kept) {
  let common = 0
  while (common < path.length && common < order.length - 1 && path[common] === order[common]) common++
  while (path.length > common) {
    chess.undo()
    path = path.slice(0, -1)
  }
  let ok = true
  while (path.length < order.length - 1) {
    const c = order[path.length]
    try {
      chess.move(sans[c.charCodeAt(0) - 0x100])
    } catch {
      ok = false
      break
    }
    path += c
  }
  if (!ok) continue
  const key = positionKey(chess.fen())
  let move
  try {
    move = chess.move(sans[order.at(-1).charCodeAt(0) - 0x100])
  } catch {
    continue
  }
  chess.undo()
  const uci = move.from + move.to + (move.promotion ?? '')
  let moves = positions.get(key)
  if (!moves) positions.set(key, (moves = new Map()))
  const prev = moves.get(uci)
  moves.set(uci, prev ? prev.map((v, k) => v + row[k]) : row)
}
console.log(`${positions.size} positions`)

// Write the shards: { key rest: [[uci, w, d, b (band 0), w, d, b (band 1), …], …] }, most played first
rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })
const shards = new Map()
for (const [key, moves] of positions) {
  const shard = key.slice(0, SHARD_DIGITS)
  if (!shards.has(shard)) shards.set(shard, {})
  const total = (row) => row.reduce((a, b) => a + b, 0)
  shards.get(shard)[key.slice(SHARD_DIGITS)] = [...moves].sort((a, b) => total(b[1]) - total(a[1])).map(([uci, row]) => [uci, ...row])
}
let bytes = 0
for (const [shard, data] of shards) {
  const text = JSON.stringify(data)
  bytes += text.length
  writeFileSync(`${OUT}/${shard}.json`, text)
}
const meta = {
  source: String(source).replace(/^.*\//, ''),
  license: 'Lichess open database, CC0 (https://database.lichess.org)',
  games,
  plies: PLIES,
  minGames: MIN_GAMES,
  bands: BANDS,
  shardDigits: SHARD_DIGITS,
  maxUndercount: dropError,
  built: new Date().toISOString().slice(0, 10),
}
writeFileSync(`${OUT}/meta.json`, JSON.stringify(meta, null, 1))
console.log(`wrote ${shards.size} shards, ${(bytes / 1e6).toFixed(1)} MB; max undercount ${dropError} (${dropped} prunes)`)
