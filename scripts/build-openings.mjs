// Builds src/data/openings.json from the Lichess chess-openings dataset (CC0,
// https://github.com/lichess-org/chess-openings). Run with: node scripts/build-openings.mjs
//
// Every position along every named line counts as "book". Positions are stored as 32-bit hashes of the
// position part of the FEN (pieces, side to move, castling, en passant), which keeps the file small; with
// ~10k positions the chance of a random game position colliding with one is negligible.
import { Chess } from 'chess.js'
import { mkdirSync, writeFileSync } from 'node:fs'
import { positionHash } from '../src/openingHash.ts'

const BASE = 'https://raw.githubusercontent.com/lichess-org/chess-openings/master'
const book = new Set()
const named = new Map() // hash -> [eco, name] for the position a named line ends in

for (const file of ['a', 'b', 'c', 'd', 'e']) {
  const res = await fetch(`${BASE}/${file}.tsv`)
  if (!res.ok) throw new Error(`${file}.tsv: HTTP ${res.status}`)
  const rows = (await res.text()).trim().split('\n').slice(1)
  for (const row of rows) {
    const [eco, name, pgn] = row.split('\t')
    const chess = new Chess()
    chess.loadPgn(pgn)
    const replay = new Chess()
    for (const move of chess.history()) {
      replay.move(move)
      book.add(positionHash(replay.fen()))
    }
    named.set(positionHash(replay.fen()), [eco, name])
  }
}

mkdirSync('src/data', { recursive: true })
const out = {
  source: 'lichess-org/chess-openings (CC0)',
  book: [...book].sort((a, b) => a - b).map((h) => h.toString(36)).join(','),
  named: [...named].map(([h, [eco, name]]) => [h.toString(36), eco, name]),
}
writeFileSync('src/data/openings.json', JSON.stringify(out))
console.log(`book positions: ${book.size}, named positions: ${named.size}`)
