// Checks written commentary against the game and the engine facts.
// node scripts/check-commentary.mjs <repo> <factsDir> <commentary.json> [...]
// - every comment's ply exists, en and sv are filled in
// - a comment's line is legal from where it starts
// - every move mentioned with a number ("16.Qb8+", "13...Nxd7") was played in the game at that number, or is in
//   the engine's lines from the facts, or in the comment's own line
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const [repo, factsDir, ...files] = process.argv.slice(2)
const require = createRequire(repo + '/package.json')
const { Chess } = require('chess.js')

const MOVE = /\b(\d+)\.(\.\.)?\s?((?:[KQRBN][a-h]?[1-8]?x?[a-h][1-8]|[a-h]x[a-h][1-8](?:=[QRBN])?|[a-h][1-8](?:=[QRBN])?|O-O-O|O-O)[+#]?)/g
const norm = (san) => san.replace(/[+#!?]/g, '')

/** Moves in "13.Rxd7 Nxd7 14.Bxe7" form as "13w Rxd7", "13b Nxd7", "14w Bxe7". */
function tokens(text) {
  const out = new Set()
  let n = 0
  let color = 'w'
  for (const tok of text.split(/\s+/)) {
    const m = tok.match(/^(\d+)(\.\.\.|\.)(.+)$/)
    if (m) {
      n = Number(m[1])
      color = m[2] === '.' ? 'w' : 'b'
      out.add(`${n}${color} ${norm(m[3])}`)
      color = color === 'w' ? 'b' : 'w'
      if (color === 'w') n++
    } else if (tok && n) {
      out.add(`${n}${color} ${norm(tok)}`)
      color = color === 'w' ? 'b' : 'w'
      if (color === 'w') n++
    }
  }
  return out
}

let problems = 0
for (const file of files) {
  const c = JSON.parse(readFileSync(file, 'utf8'))
  const facts = JSON.parse(readFileSync(`${factsDir}/${c.id}.json`, 'utf8'))
  const known = new Set()
  for (const p of facts.plies) {
    known.add(`${p.move.match(/^\d+/)[0]}${p.color} ${norm(p.move.replace(/^\d+\.(\.\.)?/, ''))}`)
    for (const l of p.topLines) for (const t of tokens(l.line)) known.add(t)
    if (p.replyLine) for (const t of tokens(p.replyLine)) known.add(t)
  }
  const fail = (where, msg) => {
    problems++
    console.log(`${c.id} ${where}: ${msg}`)
  }
  const texts = [['intro', c.intro, null], ['summary', c.summary, null], ...c.comments.map((k) => [`ply ${k.ply}`, k, k])]
  for (const [where, text, k] of texts) {
    if (!text?.en || !text?.sv) fail(where, 'missing en or sv')
    const own = new Set(known)
    if (k) {
      const p = facts.plies[k.ply]
      if (!p) {
        fail(where, 'no such ply')
        continue
      }
      if (k.line) {
        const after = new Chess(p.fenBefore)
        after.move(p.move.replace(/^\d+\.(\.\.)?/, ''))
        const start = k.line.from === 'before' ? p.fenBefore : after.fen()
        const ch = new Chess(start)
        const sans = []
        for (const san of k.line.san) {
          try {
            const m = ch.move(san)
            const num = m.before.split(' ')[5]
            sans.push(m.color === 'w' ? `${num}.${m.san}` : sans.length ? m.san : `${num}...${m.san}`)
          } catch {
            fail(where, `illegal move in line: ${san} (line ${k.line.san.join(' ')})`)
            break
          }
        }
        for (const t of tokens(sans.join(' '))) own.add(t)
      }
    }
    for (const lang of ['en', 'sv']) {
      for (const m of (text?.[lang] ?? '').matchAll(MOVE)) {
        const key = `${m[1]}${m[2] ? 'b' : 'w'} ${norm(m[3])}`
        if (!own.has(key)) fail(where, `${lang}: "${m[0]}" is neither a game move nor in the engine's lines`)
      }
    }
  }
  console.log(`${c.id}: ${c.comments.length} comments checked`)
}
console.log(problems ? `${problems} problem(s)` : 'all good')
process.exit(problems ? 1 : 0)
