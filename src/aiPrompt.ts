// "Ask an AI": a self-contained prompt with the game and its engine review, to paste into any chat LLM.
// LLMs are poor at calculating chess positions, so the prompt hands them the engine's facts (evals, labels,
// better lines) and asks them to explain and coach, not to analyse from scratch.
import { Chess } from 'chess.js'
import { aggregateAccuracy, formatScore, pvToSan, REVIEW_LIMITS, type Game, type Label, type Review } from './analysis'
import { formatLine, moveName, phaseOf, type Phase } from './explain'
import type { BookInfo } from './openings'
import type { GreatMove } from './greatMoves'
import { getLang } from './i18n'
import type { EngineLine } from './engine'
import { positionLinkBase } from './positionLink'

export type Side = 'w' | 'b' | null // the side the user played, or null when just reviewing someone's game

const LANGUAGE: Record<string, string> = { en: 'English', sv: 'Swedish' }
const ERRORS: Label[] = ['inaccuracy', 'mistake', 'blunder']
const PLURAL: Partial<Record<Label, string>> = { inaccuracy: 'inaccuracies', mistake: 'mistakes', blunder: 'blunders' }
const LINE_MOVES = 8 // engine lines are cut to this many moves (deeper moves are less reliable at review depth)

export function buildAiPrompt(game: Game, review: Review, book: BookInfo | null, me: Side, pgn: string, brilliant: Set<number>, great: Map<number, GreatMove>): string {
  const { meta } = game
  const name = (c: 'w' | 'b') => (c === 'w' ? meta.white : meta.black)
  const colour = (c: 'w' | 'b') => (c === 'w' ? 'White' : 'Black')
  const out: string[] = []

  out.push(
    me
      ? `I played this chess game as ${colour(me)} (${name(me)}). Please act as my chess coach and review it with me.`
      : 'Please act as a chess coach and review this chess game with me.',
    '',
    `Below is an engine review (Stockfish 19, depth ${review.depth ?? REVIEW_LIMITS.depth}). Treat the engine data as ground truth: ` +
      'do not invent your own variations or evaluations. When you show a line, use the lines given here. ' +
      'Evaluations are from White\'s point of view (+ is good for White; "M3" means White mates in 3, "-M3" Black mates in 3).',
    '',
  )

  // --- Game facts
  out.push('## Game')
  const elo = (c: 'w' | 'b') => (c === 'w' ? meta.whiteElo : meta.blackElo)
  for (const c of ['w', 'b'] as const) out.push(`- ${colour(c)}: ${name(c)}${elo(c) ? ` (rated ${elo(c)})` : ''}`)
  out.push(`- Result: ${meta.result}`)
  if (meta.date) out.push(`- Date: ${meta.date}`)
  if (meta.timeClass) out.push(`- Time control: ${meta.timeClass}`)
  const opening = meta.opening ?? book?.opening?.name
  if (opening) out.push(`- Opening: ${opening}`)
  if (book && book.bookPlies > 0) {
    out.push(
      book.bookPlies >= game.plies.length
        ? '- The whole game followed known opening theory.'
        : `- ${name(game.plies[book.bookPlies].color)} left opening theory with ${moveName(game, book.bookPlies)}.`,
    )
  }
  out.push('')

  // --- Review summary
  out.push('## Engine review summary')
  for (const c of ['w', 'b'] as const) {
    const est = review.rating[c]
    const brilliants = [...brilliant].filter((i) => game.plies[i].color === c).length
    const greats = [...great.keys()].filter((i) => game.plies[i].color === c).length
    const errors = (brilliants ? `${brilliants} brilliant (!!), ` : '') + (greats ? `${greats} great (!, only good move), ` : '') + ERRORS.map((l) => `${review.counts[c][l]} ${PLURAL[l]}`).join(', ')
    out.push(
      `- ${colour(c)}: accuracy ${review.accuracy[c].toFixed(1)}%, average centipawn loss ${Math.round(review.acpl[c])}, ` +
        `${errors}; played like ~${est.value}${est.precision === 'rough' || !est.reliable ? ' (rough estimate)' : ''}`,
    )
  }
  const byPhase = accuracyByPhase(game, review)
  if (byPhase) out.push(`- Accuracy by phase: ${byPhase}`)
  out.push('')

  // --- Moves
  out.push('## Moves with engine evaluation after each move')
  out.push(movesTable(game, review, book, brilliant, great))
  out.push('')

  // --- Errors in detail
  // Book moves are theory, never errors (as in the rest of the app)
  const bookPlies = book?.bookPlies ?? 0
  const errors = review.moves.map((m, i) => ({ m, i })).filter(({ m, i }) => i >= bookPlies && ERRORS.includes(m.label))
  if (errors.length) {
    out.push('## Errors in detail')
    for (const { m, i } of errors) {
      const ply = game.plies[i]
      const before = review.evals[i]
      const after = review.evals[i + 1]
      out.push(
        `- ${moveName(game, i)} by ${name(ply.color)}: ${m.label}, ${formatScore(before.score)} → ${formatScore(after.score)}, ` +
          `lost ${Math.round(m.winLoss)}% winning chances.`,
      )
      if (before.pv.length) out.push(`  - Better: ${formatLine(ply.fenBefore, before.pv, LINE_MOVES)}`)
      if (after.pv.length) out.push(`  - Engine's reply after the move played: ${formatLine(ply.fenAfter, after.pv, LINE_MOVES)}`)
      out.push(`  - Board link (the position before ${moveName(game, i)}): ${positionLinkBase(ply.fenBefore)}`)
    }
    out.push('')

    // Links that show lines on the user's board, since following lines blind is hard
    const first = errors.find(({ i }) => review.evals[i].pv.length >= 2)
    const example = first ? (() => {
      const ply = game.plies[first.i]
      const pv = review.evals[first.i].pv
      return ` For example [${formatLine(ply.fenBefore, pv, 2)}](${positionLinkBase(ply.fenBefore)}${pvToSan(ply.fenBefore, pv, 2).join(',')}).`
    })() : ''
    out.push(
      '## Show lines on my board',
      "I find it hard to picture moves in my head, so whenever you show a line of moves for one of the errors, make it a link that opens it on my analysis board: " +
        "take that error's board link and append the moves in standard notation, separated by commas, with no spaces, starting with the move that should have been played. " +
        `The link text should be the moves themselves.${example}`,
      '',
    )
  }

  out.push('## PGN', '```', pgn.trim(), '```', '')

  // --- The ask
  const whose = me ? 'My' : "The game's"
  out.push(
    '## How to answer',
    'Use exactly this format, at most about 220 words in total:',
    '',
    '**In a nutshell:** one line with your overall, human impression of the game, the way a strong player would sum it up to a friend ' +
      '(for example "a wild tactical brawl", "a calm, very accurate game by White", "even for a long time, then one slip decided it").',
    '**The game:** one or two sentences on how it went and where it was decided.',
    `**Key mistakes:** ${whose} 3 most costly mistakes, one bullet each: the move, then one short sentence on what was missed and the idea behind the better move. At most one short line of moves per bullet, as a board link (see above).`,
    `**Work on:** at most 2 bullets, each one concrete thing to practise.`,
    '**Done well:** one line.',
    '',
    'No introduction, no closing remarks, no repeating the numbers above unless they matter. ' +
      `Plain language a club player understands. I can ask follow-up questions if I want more. Answer in ${LANGUAGE[getLang()] ?? 'English'}.`,
  )
  return out.join('\n')
}

/** "12. Nf3 +0.35 | Qd2 −0.10 ?!" — one row per move number; book moves marked, errors glyphed. */
function movesTable(game: Game, review: Review, book: BookInfo | null, brilliant: Set<number>, great: Map<number, GreatMove>): string {
  const GLYPH: Partial<Record<Label, string>> = { inaccuracy: '?!', mistake: '?', blunder: '??' }
  const cell = (i: number) => {
    const m = review.moves[i]
    const tag = book && i < book.bookPlies ? ' (book)' : brilliant.has(i) ? ' !! (brilliant sacrifice)' : great.has(i) ? ` ! (only good move${great.get(i)!.lateFind ? ', hard to spot' : ''})` : GLYPH[m.label] ? ` ${GLYPH[m.label]}` : ''
    return `${game.plies[i].san}${tag} ${formatScore(review.evals[i + 1].score)}`
  }
  const rows: string[] = []
  game.plies.forEach((p, i) => {
    const n = p.fenBefore.split(' ')[5]
    if (p.color === 'w') rows.push(`${n}. ${cell(i)}`)
    else if (i === 0) rows.push(`${n}... ${cell(i)}`)
    else rows[rows.length - 1] += ` | ${cell(i)}`
  })
  return rows.join('\n')
}

function accuracyByPhase(game: Game, review: Review): string | null {
  const acc: Record<Phase, { w: number[]; b: number[] }> = { opening: { w: [], b: [] }, middlegame: { w: [], b: [] }, endgame: { w: [], b: [] } }
  game.plies.forEach((p, i) => acc[phaseOf(p.fenBefore, i)][p.color].push(review.moves[i].accuracy))
  const avg = (v: number[]) => (v.length ? `${Math.round(aggregateAccuracy(v))}%` : '–')
  const parts = (['opening', 'middlegame', 'endgame'] as Phase[])
    .filter((ph) => acc[ph].w.length + acc[ph].b.length > 0)
    .map((ph) => `${ph} White ${avg(acc[ph].w)} / Black ${avg(acc[ph].b)}`)
  return parts.length ? parts.join('; ') : null
}

// --- Chat about one position --------------------------------------------------

export interface PositionContext {
  game: Game // for names, ratings and the moves before the position
  ply: number // mainline plies played before the position (where any side line branches off)
  variation: string[] // side-line moves (SAN) played after `ply`, if any
  fen: string
  me: Side
  opening: string | null // opening name at this position, if known
  lines: EngineLine[] // engine lines in this position, best first
  lastMove: { name: string; verdict: string; comment: string | null } | null // the move that led here, as judged
  link: string // opens this position on the user's board; SAN moves are appended after it, comma-separated
}

const PIECE_ORDER = 'kqrbnp'
const PIECE_LETTER: Record<string, string> = { k: 'K', q: 'Q', r: 'R', b: 'B', n: 'N' }
const PIECE_VALUE: Record<string, number> = { q: 9, r: 5, b: 3, n: 3, p: 1, k: 0 }

/**
 * A prompt to start a conversation about one position. The engine stays the source of truth for tactics and
 * evaluations; the AI brings what the engine can't put into words (plans, structure, typical ideas, theory).
 */
export function buildPositionPrompt(c: PositionContext): string {
  const { meta } = c.game
  const chess = new Chess(c.fen)
  const toMove = chess.turn() === 'w' ? 'White' : 'Black'
  const moveNo = c.fen.split(' ')[5]
  const out: string[] = []

  out.push(
    'I want to talk about a chess position with you as my coach.',
    '',
    '## Position',
    `- FEN: ${c.fen}`,
    `- ${toMove} to move (move ${moveNo}).`,
  )
  // A piece list, because language models often misread FEN strings.
  let material = 0
  for (const side of ['w', 'b'] as const) {
    const own = chess
      .board()
      .flat()
      .filter((p): p is NonNullable<typeof p> => p !== null && p.color === side)
      .sort((a, b) => PIECE_ORDER.indexOf(a.type) - PIECE_ORDER.indexOf(b.type) || a.square.localeCompare(b.square))
    for (const p of own) material += (side === 'w' ? 1 : -1) * PIECE_VALUE[p.type]
    const pieces = own.filter((p) => p.type !== 'p').map((p) => PIECE_LETTER[p.type] + p.square)
    const pawns = own.filter((p) => p.type === 'p').map((p) => p.square)
    out.push(`- ${side === 'w' ? 'White' : 'Black'}: ${pieces.join(', ')}${pawns.length ? `; pawns on ${pawns.join(', ')}` : '; no pawns'}`)
  }
  out.push(material === 0 ? '- Material is equal.' : `- Material: ${material > 0 ? 'White' : 'Black'} is up ${Math.abs(material)} (pawn = 1, knight/bishop = 3, rook = 5, queen = 9).`)

  // Where the position comes from
  out.push('', '## Game')
  const who = (col: 'w' | 'b') => {
    const name = col === 'w' ? meta.white : meta.black
    const elo = col === 'w' ? meta.whiteElo : meta.blackElo
    return `${name}${elo ? ` (${elo})` : ''}`
  }
  if (c.game.plies.length) {
    out.push(`- White: ${who('w')}, Black: ${who('b')}${c.me ? `. I played ${c.me === 'w' ? 'White' : 'Black'}.` : '.'}`)
    if (meta.timeClass) out.push(`- Time control: ${meta.timeClass}`)
  }
  if (c.opening) out.push(`- Opening: ${c.opening}`)
  const played = c.game.plies.slice(0, c.ply)
  if (played.length) out.push(`- Moves so far: ${formatLine(c.game.startFen, played.map((p) => p.uci), played.length)}`)
  if (c.variation.length) out.push(`- Then, in a side line I'm exploring (not played in the game): ${c.variation.join(' ')}`)
  if (c.lastMove) {
    out.push(`- The last move, ${c.lastMove.name}, was judged by the engine: ${c.lastMove.verdict}.${c.lastMove.comment ? ` ${c.lastMove.comment}` : ''}`)
  }

  // Engine facts
  if (c.lines.length) {
    const depth = Math.max(...c.lines.map((l) => l.depth))
    out.push('', `## Engine (Stockfish 19, depth ${depth}), best lines from here`)
    c.lines.forEach((l, i) => out.push(`${i + 1}. ${formatScore(l.score)}: ${formatLine(c.fen, l.pv, LINE_MOVES)}`))
    out.push('Evaluations are from White\'s point of view (+ is good for White; "M3" means White mates in 3, "-M3" Black mates in 3).')
  }

  // Links that show lines on the user's board, since they can't follow lines blind
  const example = c.lines[0]?.pv.length ? pvToSan(c.fen, c.lines[0].pv, 2) : []
  out.push(
    '',
    '## Show lines on my board',
    "I find it hard to picture moves in my head, so whenever you mention a line of moves, make it a link that opens it on my analysis board. " +
      'Take this link and append the moves in standard notation, separated by commas, with no spaces:',
    c.link,
    `The link text should be the moves themselves${example.length ? `, for example [${formatLine(c.fen, c.lines[0].pv, 2)}](${c.link}${example.join(',')})` : ''}. ` +
      `Every line must start from the position above, with ${toMove}'s move; for a line that starts later, include the moves leading to it.`,
  )

  out.push(
    '',
    '## How to talk with me',
    '- Treat the engine lines and evaluations as correct. Do not calculate your own variations or claim tactics that are not in the lines; check the piece list before saying where a piece is.',
    "- Do bring what the engine can't say: the plans for both sides, the pawn structure, good and bad pieces, typical ideas and known theory for this kind of position, and why the engine's moves make sense in human terms.",
    '- Keep answers short and conversational, like a coach next to the board.',
    '',
    `Start with 3 to 4 sentences: what is going on in this position and the main plan for ${toMove}. Then ask me what I would like to explore. Answer in ${LANGUAGE[getLang()] ?? 'English'}.`,
  )
  return out.join('\n')
}
