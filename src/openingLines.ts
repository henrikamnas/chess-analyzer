// Named opening lines (Lichess chess-openings, CC0) for the opening trainer: pick an opening, then the computer
// plays its book moves and checks yours. Built by scripts/build-openings.mjs, loaded on demand.

import { Chess } from 'chess.js'

export interface OpeningLine {
  eco: string
  name: string // e.g. "Slav Defense: Exchange Variation, Boor Attack"
  moves: string[] // UCI from the standard starting position
}

let linesPromise: Promise<OpeningLine[]> | null = null

export function loadOpeningLines(): Promise<OpeningLine[]> {
  linesPromise ??= import('./data/openingLines.json').then(({ default: data }) =>
    (data.lines as [string, string, string][]).map(([eco, name, moves]) => ({ eco, name, moves: moves.split(' ') })),
  )
  return linesPromise
}

/** "Slav Defense: Exchange Variation, Boor Attack" -> family "Slav Defense", variation "Exchange Variation". */
export function familyOf(name: string) {
  return name.split(':')[0].trim()
}

export function variationOf(name: string): string | null {
  const rest = name.split(':')[1]
  return rest ? rest.split(',')[0].trim() : null
}

/** The lines a selection covers: a whole family ("Slav Defense") or one variation ("Slav Defense: Exchange Variation"). */
export function linesFor(all: OpeningLine[], selection: string): OpeningLine[] {
  return all.filter((l) => l.name === selection || l.name.startsWith(`${selection}:`) || l.name.startsWith(`${selection},`))
}

/** Which side an opening is usually studied for: defences and answers to gambits are Black's choice. */
export function suggestedSide(selection: string): 'w' | 'b' {
  return /Defen[cs]e|Declined|Accepted|Countergambit|Counter-Gambit/i.test(familyOf(selection)) ? 'b' : 'w'
}

/**
 * The book moves after `played` (UCI from the start) within the lines, each with how many lines continue
 * with it: a move with many named sub-variations is a main line, a lone one is a sideline or a gambit.
 */
export function bookReplies(lines: OpeningLine[], played: string[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const l of lines) {
    if (l.moves.length <= played.length) continue
    if (played.every((m, i) => l.moves[i] === m)) out.set(l.moves[played.length], (out.get(l.moves[played.length]) ?? 0) + 1)
  }
  return out
}

/** Picks a book move, more often the ones more lines continue with. */
export function pickBookMove(replies: Map<string, number>, random = Math.random): string | null {
  const total = [...replies.values()].reduce((a, b) => a + b, 0)
  let r = random() * total
  for (const [move, n] of replies) {
    r -= n
    if (r < 0) return move
  }
  return null
}

/** The name of the deepest named position the moves have reached, within the lines. */
export function nameAt(lines: OpeningLine[], played: string[]): string | null {
  let best: OpeningLine | null = null
  for (const l of lines) {
    if (l.moves.length > played.length) continue
    if (l.moves.every((m, i) => played[i] === m) && (!best || l.moves.length > best.moves.length)) best = l
  }
  return best?.name ?? null
}

/** Position key for transpositions: placement, side to move, castling and en passant (no move counters). */
function posKey(chess: Chess): string {
  return chess.fen().split(' ').slice(0, 4).join(' ')
}

function playUci(chess: Chess, uci: string) {
  chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] })
}

const indexes = new WeakMap<OpeningLine[], Map<string, Map<string, number>>>()

/** Every position on the lines, with the book moves from it (an empty map where lines end). */
function positionIndex(lines: OpeningLine[]): Map<string, Map<string, number>> {
  let index = indexes.get(lines)
  if (index) return index
  index = new Map()
  for (const l of lines) {
    const chess = new Chess()
    for (const m of l.moves) {
      const key = posKey(chess)
      const replies = index.get(key) ?? new Map<string, number>()
      replies.set(m, (replies.get(m) ?? 0) + 1)
      index.set(key, replies)
      playUci(chess, m)
    }
    if (!index.has(posKey(chess))) index.set(posKey(chess), new Map())
  }
  indexes.set(lines, index)
  return index
}

function positionAfter(played: string[]): Chess {
  const chess = new Chess()
  for (const m of played) playUci(chess, m)
  return chess
}

/** Whether a book move (any opening's) from here leads back onto the chosen lines: a move-order transposition. */
function returnsTo(lines: OpeningLine[], all: OpeningLine[], played: string[], chess: Chess): boolean {
  const index = positionIndex(lines)
  if (index.has(posKey(chess))) return true
  return [...bookReplies(all, played).keys()].some((m) => {
    const next = new Chess(chess.fen())
    playUci(next, m)
    return index.has(posKey(next))
  })
}

/**
 * The book moves for the trainer after `played`: those of the chosen lines in this position (by position, so
 * transpositions count); off them, any opening's moves that lead back onto them; otherwise any opening's.
 */
export function trainerReplies(lines: OpeningLine[], all: OpeningLine[], played: string[]): Map<string, number> {
  const chess = positionAfter(played)
  const chosen = positionIndex(lines).get(posKey(chess))
  if (chosen?.size) return chosen
  const any = bookReplies(all, played)
  const back = new Map([...any].filter(([m]) => returnsTo(lines, all, [...played, m], positionAfter([...played, m]))))
  return back.size ? back : any
}

/**
 * Where a played sequence stands against the book: still in book, at the end of the book (no opening goes on),
 * or off book at move `at` (0-based), where book moves were available but another was played. While the chosen
 * lines have moves in the position, a move must be one of them, or a book move that transposes straight back
 * (one more book move reaches the chosen lines again): another variation of the same opening is leaving it.
 * Past the end of the chosen lines, any named opening's moves count.
 */
export function bookStatus(
  lines: OpeningLine[],
  all: OpeningLine[],
  played: string[],
): { kind: 'book' } | { kind: 'ended'; at: number } | { kind: 'left'; at: number } {
  const index = positionIndex(lines)
  const chess = new Chess()
  for (let i = 0; i < played.length; i++) {
    const before = played.slice(0, i)
    const chosen = index.get(posKey(chess))
    const any = bookReplies(all, before)
    const m = played[i]
    if (chosen?.size) {
      if (chosen.has(m)) {
        playUci(chess, m)
        continue
      }
      if (!any.has(m)) return { kind: 'left', at: i }
      playUci(chess, m)
      if (!returnsTo(lines, all, [...before, m], chess)) return { kind: 'left', at: i }
      continue
    }
    if (!any.has(m)) return any.size ? { kind: 'left', at: i } : { kind: 'ended', at: i }
    playUci(chess, m)
  }
  return trainerReplies(lines, all, played).size ? { kind: 'book' } : { kind: 'ended', at: played.length }
}
