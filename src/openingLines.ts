// Named opening lines (Lichess chess-openings, CC0) for the opening trainer: pick an opening, then the computer
// plays its book moves and checks yours. Built by scripts/build-openings.mjs, loaded on demand.

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

/**
 * Where a played sequence stands against the lines: still in book, at the end of the book (every line through
 * it has ended), or off book at move `at` (0-based), where book moves were available but another was played.
 */
export function bookStatus(lines: OpeningLine[], played: string[]): { kind: 'book' } | { kind: 'ended'; at: number } | { kind: 'left'; at: number } {
  for (let i = 0; i < played.length; i++) {
    const replies = bookReplies(lines, played.slice(0, i))
    if (replies.has(played[i])) continue
    return replies.size ? { kind: 'left', at: i } : { kind: 'ended', at: i }
  }
  return bookReplies(lines, played).size ? { kind: 'book' } : { kind: 'ended', at: played.length }
}
