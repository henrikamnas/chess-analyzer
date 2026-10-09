// Opening book: which moves of a game follow known theory, and the opening's name.
// Data: Lichess chess-openings (CC0), compiled by scripts/build-openings.mjs and loaded on demand.
import { Chess } from 'chess.js'
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
  /** Whether the game starts from the standard position (otherwise nothing in it is book). */
  fromStart: boolean
}

export interface Db {
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
  return { bookPlies, openingAt, opening: current, fromStart }
}

/**
 * Follows a line of positions from a position that is in book: how many of them in a row stay in book, and
 * the opening name after each of those (the deepest named position so far, starting from `opening`).
 */
export function followBook(db: Db, fens: string[], opening: Opening | null): { plies: number; openingAt: (Opening | null)[] } {
  const openingAt: (Opening | null)[] = []
  let current = opening
  for (const fen of fens) {
    const h = positionHash(fen)
    if (!db.book.has(h)) break
    current = db.named.get(h) ?? current
    openingAt.push(current)
  }
  return { plies: openingAt.length, openingAt }
}

/** How many moves of an engine line (UCI) from a book position are book moves. */
export function bookMovesInLine(db: Db, fen: string, pv: string[]): number {
  const chess = new Chess(fen)
  const fens: string[] = []
  for (const uci of pv) {
    try {
      chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] })
    } catch {
      break
    }
    fens.push(chess.fen())
  }
  return followBook(db, fens, null).plies
}
