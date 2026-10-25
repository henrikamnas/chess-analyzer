// How hard an opening is to play for one side at a level: at each of your moves, the share of players at the
// level who play a move that works (a book move, or one that scores as well in their games). From the Lichess
// statistics where the position has enough games, else Maia's prediction with the engine judging its moves.
import { Chess } from 'chess.js'
import { winPercent } from './analysis'
import { Engine } from './engine'
import { movesAt } from './explorer'
import { maiaMoves } from './maia'
import { bookReplies, type OpeningLine } from './openingLines'

/** Under this share, a move counts as tricky to find. */
export const TRICKY = 0.25
const MIN_GAMES = 50 // games in a position before its statistics are trusted over Maia
const OK_SCORE = 0.05 // a move outside the book is fine if players score within this of the best book move
const MIN_REACH = 0.03 // positions reached less often than this don't count towards a line's difficulty
const GOOD_LOSS = 5 // win% a move outside the book may lose against the book and still work
const CHECK_DEPTH = 10

// One engine for judging Maia's moves, shut down when it has been idle for a while
let engine: Engine | null = null
let idle: ReturnType<typeof setTimeout> | undefined
async function evalAfter(fen: string, uci: string): Promise<number> {
  clearTimeout(idle)
  engine ??= new Engine({ onError: () => {} })
  const chess = new Chess(fen)
  const mover = chess.turn()
  chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] })
  let win: number
  if (chess.isCheckmate()) win = 100
  else if (chess.isDraw()) win = 50
  else {
    const w = winPercent((await engine.analyze(chess.fen(), { depth: CHECK_DEPTH })).score)
    win = mover === 'w' ? w : 100 - w
  }
  idle = setTimeout(() => {
    engine?.terminate()
    engine = null
  }, 20_000)
  return win
}

export interface Find {
  p: number // share of players at the level who play a move that works
  source: 'games' | 'maia'
}

const cache = new Map<string, Promise<Find | null>>()

/**
 * The share of players at the level who find a move that works in the last position of `history` (FENs,
 * oldest first): one of `book`, or a move that scores about as well as the book in their games.
 */
export function findShare(history: string[], book: string[], band: number, net: number): Promise<Find | null> {
  const fen = history[history.length - 1]
  const key = `${fen}|${band}|${net}|${[...book].sort().join(',')}`
  let p = cache.get(key)
  if (!p) {
    p = computeShare(history, book, band, net)
    cache.set(key, p)
  }
  return p
}

async function computeShare(history: string[], book: string[], band: number, net: number): Promise<Find | null> {
  const fen = history[history.length - 1]
  const stats = await movesAt(fen, band, MIN_GAMES)
  if (stats && stats.reduce((a, s) => a + s.games, 0) >= MIN_GAMES) {
    // The bar other moves have to clear: the best book move's score, or the position's average when the book
    // moves are too rare to have one (a deep line's move few players know, while the usual moves are fine too)
    const total = stats.reduce((a, s) => a + s.games, 0)
    const average = stats.reduce((a, s) => a + s.score * s.games, 0) / total
    const bookScore = Math.max(-1, ...stats.filter((s) => book.includes(s.uci) && s.games >= 10).map((s) => s.score))
    const bar = bookScore >= 0 ? bookScore - OK_SCORE : average
    const works = (s: (typeof stats)[number]) => book.includes(s.uci) || (s.games >= 20 && s.score >= bar)
    return { p: stats.filter(works).reduce((a, s) => a + s.share, 0), source: 'games' }
  }
  try {
    const moves = await maiaMoves(history, net)
    // Maia's likely moves outside the book work if the engine finds them about as good as the book's best
    const others = moves.filter((m) => m.p >= 0.05 && !book.includes(m.uci)).slice(0, 4)
    let ok = new Set<string>()
    if (others.length) {
      const bookWin = Math.max(...(await Promise.all(book.map((m) => evalAfter(fen, m)))))
      const wins = await Promise.all(others.map((m) => evalAfter(fen, m.uci)))
      ok = new Set(others.filter((_, i) => bookWin - wins[i] < GOOD_LOSS).map((m) => m.uci))
    }
    return { p: moves.filter((m) => book.includes(m.uci) || ok.has(m.uci)).reduce((a, m) => a + m.p, 0), source: 'maia' }
  } catch {
    return null
  }
}

/** How often players at the level choose each of `moves` in a position (equal shares without statistics). */
async function weights(fen: string, moves: Map<string, number>, band: number): Promise<Map<string, number>> {
  const stats = await movesAt(fen, band)
  const total = stats?.reduce((a, s) => a + s.games, 0) ?? 0
  const raw = [...moves].map(([m, lines]) => {
    const games = stats?.find((s) => s.uci === m)?.games ?? 0
    // Book moves nobody played still get a small share, as when the computer picks its moves
    return [m, total ? Math.max(games, 0.005 * total) : lines] as const
  })
  const sum = raw.reduce((a, [, w]) => a + w, 0)
  return new Map(raw.map(([m, w]) => [m, w / sum]))
}

export interface TrickyMove {
  ply: number // 0-based index of your move from the start
  after: string | null // the opponent's move before it, e.g. "4. Nc3" (null for White's first move)
  p: number
  reach: number // how often the position comes up when the opponent plays like players at the level
}

export interface Difficulty {
  rating: 'easy' | 'medium' | 'hard'
  tricky: TrickyMove[] // most often reached first
  /** Chance a player at the level plays the whole line without a move that doesn't work. */
  clean: number
}

/**
 * Walks the book tree of `lines` from the starting position: the opponent's moves as often as players at the
 * level play them, yours the way they do. Collects the tricky moves on the way and the chance of getting through
 * cleanly. Rarely reached positions are left out.
 */
export async function lineDifficulty(lines: OpeningLine[], side: 'w' | 'b', band: number, net: number, isCancelled = () => false): Promise<Difficulty | null> {
  const tricky = new Map<string, TrickyMove>()
  const walk = async (played: string[], fens: string[], sans: string[], reach: number): Promise<number> => {
    const replies = bookReplies(lines, played)
    if (!replies.size || reach < MIN_REACH || isCancelled()) return 1
    const fen = fens[fens.length - 1]
    const mine = fen.split(' ')[1] === side
    let p = 1
    if (mine) {
      const f = await findShare(fens.slice(-8), [...replies.keys()], band, net)
      p = f?.p ?? 1
      if (p < TRICKY) {
        // The same position by another move order counts once (the move counters don't matter)
        const key = fen.split(' ').slice(0, 4).join(' ')
        const old = tricky.get(key)
        if (old) old.reach += reach
        else tricky.set(key, { ply: played.length, after: played.length ? moveLabel(played.length - 1, sans[sans.length - 1]) : null, p, reach })
      }
    }
    let rest = 0
    for (const [m, w] of await weights(fen, replies, band)) {
      const chess = new Chess(fen)
      const san = chess.move({ from: m.slice(0, 2), to: m.slice(2, 4), promotion: m[4] }).san
      rest += w * (await walk([...played, m], [...fens, chess.fen()], [...sans, san], reach * (mine ? w * p : w)))
    }
    return p * rest
  }
  const start = new Chess().fen()
  const clean = await walk([], [start], [], 1)
  if (isCancelled()) return null
  const list = [...tricky.values()].filter((m) => m.reach >= MIN_REACH).sort((a, b) => b.reach - a.reach || a.ply - b.ply)
  // Rated by how many tricky moves you can expect to meet in a game, and the chance of a clean run
  const expected = list.reduce((a, m) => a + m.reach, 0)
  const rating = expected >= 0.6 || clean < 0.25 ? 'hard' : expected >= 0.2 || clean < 0.5 ? 'medium' : 'easy'
  return { rating, tricky: list, clean }
}

/** "4. Nc3" or "4... dxc4" for the move at a 0-based ply from the starting position. */
function moveLabel(ply: number, san: string) {
  const n = Math.floor(ply / 2) + 1
  return ply % 2 === 0 ? `${n}. ${san}` : `${n}... ${san}`
}
