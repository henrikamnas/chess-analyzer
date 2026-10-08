// Opening book: which moves of a game follow known theory, and the opening's name.
// Data: Lichess chess-openings (CC0), compiled by scripts/build-openings.mjs and loaded on demand.
import type { Game } from './analysis'
import { positionHash } from './openingHash'

export interface Opening {
  eco: string
  name: string
}

export interface BookInfo {
  /** Number of plies from the start that are book moves (the game left theory on the next ply). */
  bookPlies: number
  /** Opening name after each ply (index = ply count): the deepest named position reached so far. */
  openingAt: (Opening | null)[]
  /** The opening the game ended up in (deepest named position while in book). */
  opening: Opening | null
}

interface Db {
  book: Set<number>
  named: Map<number, Opening>
}

let dbPromise: Promise<Db> | null = null

export function loadOpenings(): Promise<Db> {
  dbPromise ??= import('./data/openings.json').then(({ default: data }) => ({
    book: new Set(data.book.split(',').map((h: string) => parseInt(h, 36))),
    named: new Map((data.named as [string, string, string][]).map(([h, eco, name]) => [parseInt(h, 36), { eco, name }])),
  }))
  return dbPromise
}

/** Book moves only count from the standard starting position (not from custom setups). */
const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -'

export function bookInfo(game: Game, db: Db): BookInfo {
  const fromStart = game.startFen.startsWith(START)
  let bookPlies = 0
  let current: Opening | null = null
  const openingAt: (Opening | null)[] = [null]
  let inBook = fromStart
  game.plies.forEach((ply, i) => {
    const h = positionHash(ply.fenAfter)
    if (inBook && db.book.has(h)) {
      bookPlies = i + 1
      current = db.named.get(h) ?? current
    } else {
      inBook = false
    }
    openingAt.push(current)
  })
  return { bookPlies, openingAt, opening: current }
}
