// Engine facts for famous games, as grounding for written commentary (public/famous/commentary): per move,
// Stockfish 19's evaluation before and after, its top three lines, the opening name and the material.
// The commentary is written from these facts and checked against them with check-commentary.mjs.
// node scripts/commentary-facts.mjs <repo> <outDir> <id> [<id> ...]
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'

const [repo, outDir, ...ids] = process.argv.slice(2)
const require = createRequire(repo + '/package.json')
const { Chess } = require('chess.js')
const games = JSON.parse(readFileSync(repo + '/public/famous/games.json', 'utf8')).games
const lines = JSON.parse(readFileSync(repo + '/src/data/openingLines.json', 'utf8')).lines.map(([eco, name, moves]) => ({ eco, name, moves: moves.split(' ') }))
mkdirSync(outDir, { recursive: true })

// --- UCI engine ---
const sf = spawn('node', [repo + '/node_modules/stockfish/bin/stockfish-19.js'])
let buf = ''
let listener = null
sf.stdout.on('data', (d) => {
  buf += d
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    listener?.(line)
  }
})
const send = (s) => sf.stdin.write(s + '\n')
const until = (pred) => new Promise((res) => (listener = (l) => pred(l) && res(l)))
send('uci')
await until((l) => l === 'uciok')
send('setoption name Threads value 12')
send('setoption name Hash value 512')
send('setoption name MultiPV value 3')
send('isready')
await until((l) => l === 'readyok')

async function analyse(fen) {
  const pvs = []
  const onInfo = (l) => {
    if (!l.startsWith('info ') || !l.includes(' pv ') || l.includes('bound')) return
    const t = l.split(' ')
    const mp = Number(t[t.indexOf('multipv') + 1] ?? 1)
    const k = t.indexOf('score')
    const v = Number(t[k + 2])
    pvs[mp - 1] = { depth: Number(t[t.indexOf('depth') + 1]), kind: t[k + 1], v, pv: t.slice(t.indexOf('pv') + 1) }
  }
  send('position fen ' + fen)
  const done = new Promise((res) => (listener = (l) => (l.startsWith('bestmove') ? res() : onInfo(l))))
  send('go depth 22 movetime 4000')
  await done
  const white = fen.split(' ')[1] === 'w'
  return pvs.filter(Boolean).map((p) => ({
    // White's view
    score: p.kind === 'mate' ? { mate: white ? p.v : -p.v } : { cp: white ? p.v : -p.v },
    depth: p.depth,
    pv: p.pv,
  }))
}

const win = (s) => (s.mate !== undefined ? (s.mate > 0 ? 100 : 0) : 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * Math.max(-1000, Math.min(1000, s.cp)))) - 1))
const fmt = (s) => (s.mate !== undefined ? (s.mate > 0 ? `#${s.mate}` : `#-${-s.mate}`) : `${s.cp > 0 ? '+' : ''}${(s.cp / 100).toFixed(2)}`)
function sanLine(fen, pv, max = 10) {
  const c = new Chess(fen)
  const out = []
  for (const u of pv.slice(0, max)) {
    try {
      const m = c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] })
      const n = m.before.split(' ')[5]
      out.push(m.color === 'w' ? `${n}.${m.san}` : out.length ? m.san : `${n}...${m.san}`)
    } catch {
      break
    }
  }
  return out.join(' ')
}
const VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 }
function material(fen) {
  const c = new Chess(fen)
  let w = 0
  let b = 0
  for (const row of c.board()) for (const sq of row) if (sq) (sq.color === 'w' ? (w += VALUES[sq.type]) : (b += VALUES[sq.type]))
  return { white: w, black: b }
}

for (const id of ids) {
  const g = games.find((x) => x.id === id)
  if (!g) throw new Error('no game ' + id)
  const file = `${outDir}/${id}.json`
  if (existsSync(file)) continue
  const c = new Chess()
  c.loadPgn(g.moves)
  const hist = c.history({ verbose: true })
  const uci = hist.map((m) => m.from + m.to + (m.promotion ?? ''))
  const fens = [hist[0].before, ...hist.map((m) => m.after)]
  const evals = []
  for (const [i, fen] of fens.entries()) {
    const ch = new Chess(fen)
    if (ch.isGameOver()) evals.push(null)
    else evals.push(await analyse(fen))
    process.stderr.write(`\r${id} ${i + 1}/${fens.length}`)
  }
  process.stderr.write('\n')
  const plies = hist.map((m, i) => {
    const before = evals[i]
    const after = evals[i + 1]
    const best = before[0]
    const afterScore = after ? after[0].score : new Chess(m.after).isCheckmate() ? { mate: m.color === 'w' ? 1 : -1 } : { cp: 0 }
    const mover = (s) => (m.color === 'w' ? win(s) : 100 - win(s))
    const loss = Math.max(0, mover(best.score) - mover(afterScore))
    // Deepest named opening the moves so far match
    let opening = null
    for (const l of lines) if (l.moves.length <= i + 1 && l.moves.every((u, k) => uci[k] === u) && (!opening || l.moves.length > opening.moves.length)) opening = l
    return {
      ply: i, // 0-based
      move: `${m.before.split(' ')[5]}${m.color === 'w' ? '.' : '...'}${m.san}`,
      color: m.color,
      fenBefore: m.before,
      evalBefore: fmt(best.score),
      evalAfter: fmt(afterScore),
      winLossForMover: Math.round(loss),
      engineBest: best.pv[0] === uci[i] ? 'played' : sanLine(m.before, best.pv, 1),
      topLines: before.map((l) => ({ eval: fmt(l.score), line: sanLine(m.before, l.pv, 10) })),
      replyLine: after ? sanLine(m.after, after[0].pv, 10) : null,
      inBook: lines.some((l) => l.moves.length > i && uci.slice(0, i + 1).every((u, k) => l.moves[k] === u)),
      opening: opening?.name ?? null,
      materialAfter: material(m.after),
      capture: m.captured ?? null,
      check: m.san.includes('+') || m.san.includes('#'),
    }
  })
  writeFileSync(file, JSON.stringify({ id, title: g.title, white: g.white, black: g.black, event: g.event, date: g.date, result: g.result, opening: g.opening, about: g.about, moves: g.moves, plies }, null, 1))
  console.log('wrote', file)
}
send('quit')
sf.kill()
