// Plain-language explanations of individual moves and of the whole game, derived from the review.
import { Chess } from 'chess.js'
import { aggregateAccuracy, formatScore, pvToSan, winPercent, type Game, type Label, type Review } from './analysis'
import type { Score } from './engine'

const VALUE: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 }

/** Material balance in pawns, White minus Black. */
function material(chess: Chess) {
  let sum = 0
  for (const row of chess.board()) for (const sq of row) if (sq) sum += (sq.color === 'w' ? 1 : -1) * VALUE[sq.type]
  return sum
}

/** Plays a UCI line and returns the material balance at its end. */
function materialAfter(fen: string, line: string[], maxPlies: number) {
  const chess = new Chess(fen)
  for (const uci of line.slice(0, maxPlies)) {
    try {
      chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] })
    } catch {
      break
    }
  }
  return material(chess)
}

function materialWords(n: number) {
  if (n >= 8) return "a queen's worth of material"
  if (n >= 5) return 'a rook'
  if (n === 4) return 'a piece and a pawn'
  if (n === 3) return 'a piece'
  if (n === 2) return 'two pawns'
  return 'a pawn'
}

/** "12. Nf3" / "12... Nf6" */
export function moveName(game: Game, i: number) {
  const p = game.plies[i]
  const n = p.fenBefore.split(' ')[5]
  return `${n}${p.color === 'w' ? '.' : '...'} ${p.san}`
}

/** UCI line -> "19. Nd5 Qd8 20. Nxf6+" */
export function formatLine(fen: string, line: string[], max = 10) {
  const sans = pvToSan(fen, line, max)
  const [, turn, , , , full] = fen.split(' ')
  let n = Number(full)
  return sans
    .map((san, i) => {
      const white = (turn === 'w') === (i % 2 === 0)
      if (white) return `${n}. ${san}`
      const s = i === 0 ? `${n}... ${san}` : san
      n++
      return s
    })
    .join(' ')
}

function evalWords(score: Score) {
  if (score.mate !== undefined) return score.mate > 0 ? 'winning for White' : 'winning for Black'
  const cp = score.cp
  const side = cp > 0 ? 'White' : 'Black'
  const a = Math.abs(cp)
  if (a < 50) return 'about equal'
  if (a < 150) return `slightly better for ${side}`
  if (a < 400) return `clearly better for ${side}`
  return `winning for ${side}`
}

export interface MoveExplanation {
  text: string
  /** The opponent's best reply line after this move, starting from the position after it. */
  refutation: string[]
  /** The engine's preferred line instead of this move, starting from the position before it. */
  best: string[]
}

export function explainMove(game: Game, review: Review, i: number): MoveExplanation | null {
  const ply = game.plies[i]
  const rv = review.moves[i]
  if (!['inaccuracy', 'mistake', 'blunder'].includes(rv.label)) return null

  const before = review.evals[i]
  const after = review.evals[i + 1]
  const s = ply.color === 'w' ? 1 : -1
  const mover = ply.color === 'w' ? game.meta.white : game.meta.black
  const opponent = ply.color === 'w' ? game.meta.black : game.meta.white
  const refutation = after.pv
  const best = before.pv
  // Judge material over the same stretch of moves the text shows, so the claim matches the line.
  const HORIZON = 6
  const refText = refutation.length ? formatLine(ply.fenAfter, refutation, HORIZON) : ''
  const bestText = best.length ? formatLine(ply.fenBefore, best, HORIZON) : ''
  const swing = `(${formatScore(before.score)} → ${formatScore(after.score)})`
  const bestSan = rv.bestSan ?? 'another move'

  let text: string
  const afterMate = after.score.mate !== undefined ? after.score.mate * s : undefined
  const beforeMate = before.score.mate !== undefined ? before.score.mate * s : undefined

  if (afterMate !== undefined && afterMate < 0) {
    text = `This allows ${opponent} to force mate in ${Math.abs(Math.round(afterMate))}: ${refText}.`
  } else if (beforeMate !== undefined && beforeMate > 0 && (afterMate === undefined || afterMate <= 0)) {
    text = `${mover} had a forced mate in ${Math.round(beforeMate)} starting with ${bestSan}: ${bestText}.`
  } else {
    const start = s * material(new Chess(ply.fenBefore))
    const viaRefutation = s * materialAfter(ply.fenAfter, refutation, HORIZON)
    const viaBest = s * materialAfter(ply.fenBefore, best, HORIZON)
    const lost = Math.round(start - viaRefutation)
    const missed = Math.round(viaBest - start)
    const diff = Math.round(viaBest - viaRefutation)

    if (lost >= 1 && diff >= 1) {
      text = `This loses ${materialWords(Math.max(lost, diff))} ${swing}. ${opponent} answers ${refText}.`
    } else if (missed >= 1 && diff >= 1) {
      text = `This misses a chance to win ${materialWords(missed)} with ${bestSan} ${swing}: ${bestText}.`
    } else {
      text = `The position goes from ${evalWords(before.score)} to ${evalWords(after.score)} ${swing}. ${bestSan} was stronger: ${bestText}.`
    }
  }
  return { text, refutation, best }
}

// --- Whole-game summary ------------------------------------------------------

export type Phase = 'opening' | 'middlegame' | 'endgame'

function phaseOf(fen: string, plyIndex: number): Phase {
  let pieces = 0
  for (const row of new Chess(fen).board()) for (const sq of row) if (sq && sq.type !== 'p' && sq.type !== 'k') pieces++
  if (pieces <= 6) return 'endgame'
  if (plyIndex < 20 && pieces > 10) return 'opening'
  return 'middlegame'
}

export interface GameSummary {
  paragraphs: string[]
  phases: { phase: Phase; w: number | null; b: number | null }[]
  moments: { ply: number; label: Label; text: string }[] // ply = 1-based index into the mainline
}

export function rating(acc: number) {
  if (acc >= 90) return 'Excellent'
  if (acc >= 80) return 'Good'
  if (acc >= 65) return 'Inaccurate'
  return 'Poor'
}

export function summarizeGame(game: Game, review: Review): GameSummary {
  const { white, black, result, opening } = game.meta
  const name = (c: 'w' | 'b') => (c === 'w' ? white : black)
  const acc = review.accuracy
  const paragraphs: string[] = []

  // Overview
  const winner: 'w' | 'b' | null = result === '1-0' ? 'w' : result === '0-1' ? 'b' : null
  const other = (c: 'w' | 'b') => (c === 'w' ? 'b' : 'w')
  const pct = (c: 'w' | 'b') => `${acc[c].toFixed(0)}%`
  const inOpening = opening ? ` in the ${opening}` : ''
  if (winner) {
    const loser = other(winner)
    const verdict =
      acc[winner] >= acc[loser] - 3
        ? `with ${pct(winner)} accuracy against ${name(loser)}'s ${pct(loser)}`
        : `despite lower accuracy (${pct(winner)} vs ${pct(loser)})`
    paragraphs.push(`${name(winner)} won${inOpening} ${verdict}.`)
  } else {
    const outcome = result === '*' ? 'The game is unfinished' : 'The game was drawn'
    paragraphs.push(`${outcome}${inOpening}. Accuracy: ${white} ${pct('w')}, ${black} ${pct('b')}.`)
  }

  // The story: when the winner took control for good, and the biggest swing
  const story: string[] = []
  // When did the winner take control for good?
  const wins = review.evals.map((e) => winPercent(e.score))
  if (result === '1-0' || result === '0-1') {
    const winnerIsWhite = result === '1-0'
    let from = -1
    for (let i = wins.length - 1; i >= 0; i--) {
      const w = winnerIsWhite ? wins[i] : 100 - wins[i]
      if (w < 70) break
      from = i
    }
    if (from > 0 && from < wins.length - 1) {
      story.push(`${winnerIsWhite ? white : black} took a decisive advantage after ${moveName(game, from - 1)} and never let it go.`)
    } else if (from === wins.length - 1) {
      story.push(`The game was decided by the very last move.`)
    } else if (from === -1) {
      story.push(`The final position was not yet decisive, so the game was likely decided on time.`)
    }
  }

  // Biggest single swing
  let worst = -1
  review.moves.forEach((m, i) => {
    if (worst === -1 || m.winLoss > review.moves[worst].winLoss) worst = i
  })
  if (worst >= 0 && review.moves[worst].winLoss >= 10) {
    const m = review.moves[worst]
    story.push(
      `The turning point was ${moveName(game, worst)}, a ${m.label} that cost ${name(game.plies[worst].color)} about ${Math.round(m.winLoss)}% winning chances.`,
    )
  }

  if (story.length) paragraphs.push(story.join(' '))

  // Accuracy by phase
  const byPhase: Record<Phase, { w: number[]; b: number[] }> = {
    opening: { w: [], b: [] },
    middlegame: { w: [], b: [] },
    endgame: { w: [], b: [] },
  }
  game.plies.forEach((p, i) => byPhase[phaseOf(p.fenBefore, i)][p.color].push(review.moves[i].accuracy))
  const phases = (['opening', 'middlegame', 'endgame'] as Phase[])
    .filter((ph) => byPhase[ph].w.length + byPhase[ph].b.length > 0)
    .map((ph) => ({
      phase: ph,
      w: byPhase[ph].w.length ? aggregateAccuracy(byPhase[ph].w) : null,
      b: byPhase[ph].b.length ? aggregateAccuracy(byPhase[ph].b) : null,
    }))

  // Key moments: the worst errors, in game order
  const moments = review.moves
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => m.label === 'blunder' || m.label === 'mistake')
    .sort((a, b) => b.m.winLoss - a.m.winLoss)
    .slice(0, 5)
    .sort((a, b) => a.i - b.i)
    .map(({ m, i }) => ({ ply: i + 1, label: m.label, text: explainMove(game, review, i)?.text ?? '' }))

  return { paragraphs, phases, moments }
}
