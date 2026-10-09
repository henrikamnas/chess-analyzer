// "Ask an AI": a self-contained prompt with the game and its engine review, to paste into any chat LLM.
// LLMs are poor at calculating chess positions, so the prompt hands them the engine's facts (evals, labels,
// better lines) and asks them to explain and coach, not to analyse from scratch.
import { aggregateAccuracy, formatScore, REVIEW_LIMITS, type Game, type Label, type Review } from './analysis'
import { formatLine, moveName, phaseOf, type Phase } from './explain'
import type { BookInfo } from './openings'
import { getLang } from './i18n'

export type Side = 'w' | 'b' | null // the side the user played, or null when just reviewing someone's game

const LANGUAGE: Record<string, string> = { en: 'English', sv: 'Swedish' }
const ERRORS: Label[] = ['inaccuracy', 'mistake', 'blunder']
const PLURAL: Partial<Record<Label, string>> = { inaccuracy: 'inaccuracies', mistake: 'mistakes', blunder: 'blunders' }
const LINE_MOVES = 8 // engine lines are cut to this many moves (deeper moves are less reliable at review depth)

export function buildAiPrompt(game: Game, review: Review, book: BookInfo | null, me: Side, pgn: string): string {
  const { meta } = game
  const name = (c: 'w' | 'b') => (c === 'w' ? meta.white : meta.black)
  const colour = (c: 'w' | 'b') => (c === 'w' ? 'White' : 'Black')
  const out: string[] = []

  out.push(
    me
      ? `I played this chess game as ${colour(me)} (${name(me)}). Please act as my chess coach and review it with me.`
      : 'Please act as a chess coach and review this chess game with me.',
    '',
    `Below is an engine review (Stockfish 19, depth ${REVIEW_LIMITS.depth}). Treat the engine data as ground truth: ` +
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
    const errors = ERRORS.map((l) => `${review.counts[c][l]} ${PLURAL[l]}`).join(', ')
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
  out.push(movesTable(game, review, book))
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
    }
    out.push('')
  }

  out.push('## PGN', '```', pgn.trim(), '```', '')

  // --- The ask
  const whose = me ? 'My' : "The game's"
  out.push(
    '## How to answer',
    'Use exactly this format, at most about 200 words in total:',
    '',
    '**The game:** one or two sentences on how it went and where it was decided.',
    `**Key mistakes:** ${whose} 3 most costly mistakes, one bullet each: the move, then one short sentence on what was missed and the idea behind the better move. At most one short line of moves per bullet.`,
    `**Work on:** at most 2 bullets, each one concrete thing to practise.`,
    '**Done well:** one line.',
    '',
    'No introduction, no closing remarks, no repeating the numbers above unless they matter. ' +
      `Plain language a club player understands. I can ask follow-up questions if I want more. Answer in ${LANGUAGE[getLang()] ?? 'English'}.`,
  )
  return out.join('\n')
}

/** "12. Nf3 +0.35 | Qd2 −0.10 ?!" — one row per move number; book moves marked, errors glyphed. */
function movesTable(game: Game, review: Review, book: BookInfo | null): string {
  const GLYPH: Partial<Record<Label, string>> = { inaccuracy: '?!', mistake: '?', blunder: '??' }
  const cell = (i: number) => {
    const m = review.moves[i]
    const tag = book && i < book.bookPlies ? ' (book)' : GLYPH[m.label] ? ` ${GLYPH[m.label]}` : ''
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
