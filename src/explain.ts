// Plain-language explanations of individual moves and of the whole game, derived from the review.
// All text goes through t() (i18n.ts), so it follows the selected language.
import { Chess } from 'chess.js'
import { aggregateAccuracy, formatScore, pvToSan, winPercent, type Game, type Label, type Review } from './analysis'
import type { Score } from './engine'
import { sideInText, t } from './i18n'

const VALUE: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 }

/** Material balance in pawns, White minus Black. */
export function material(chess: Chess) {
  let sum = 0
  for (const row of chess.board()) for (const sq of row) if (sq) sum += (sq.color === 'w' ? 1 : -1) * VALUE[sq.type]
  return sum
}

/** Plays a UCI line and returns the material balance at its end. */
export function materialAfter(fen: string, line: string[], maxPlies: number) {
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

export function materialWords(n: number) {
  if (n >= 8) return t("a queen's worth of material")
  if (n >= 5) return t('a rook')
  if (n === 4) return t('a piece and a pawn')
  if (n === 3) return t('a piece')
  if (n === 2) return t("two pawns' worth of material")
  return t('a pawn')
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
  if (score.mate !== undefined) return t('winning for {side}', { side: sideInText(score.mate > 0 ? 'w' : 'b') })
  const cp = score.cp
  const side = sideInText(cp > 0 ? 'w' : 'b')
  const a = Math.abs(cp)
  if (a < 50) return t('about equal')
  if (a < 150) return t('slightly better for {side}', { side })
  if (a < 400) return t('clearly better for {side}', { side })
  return t('winning for {side}', { side })
}

/** Move label with article: "a mistake" / "ett misstag". */
export function labelWithArticle(label: Label) {
  return t({ best: 'a best move', good: 'a good move', inaccuracy: 'an inaccuracy', mistake: 'a mistake', blunder: 'a blunder' }[label])
}

export interface MoveExplanation {
  /** Why the played move was a mistake (shown with the opponent's punishing line). */
  text: string
  /** What the better move achieves (shown with the engine's preferred line). */
  bestText: string
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
  const refLine = refutation.length ? formatLine(ply.fenAfter, refutation, HORIZON) : ''
  const bestLine = best.length ? formatLine(ply.fenBefore, best, HORIZON) : ''
  const swing = `(${formatScore(before.score)} → ${formatScore(after.score)})`
  const move = rv.bestSan ?? t('another move')

  const afterMate = after.score.mate !== undefined ? after.score.mate * s : undefined
  const beforeMate = before.score.mate !== undefined ? before.score.mate * s : undefined
  const start = s * material(new Chess(ply.fenBefore))
  const viaRefutation = s * materialAfter(ply.fenAfter, refutation, HORIZON)
  const viaBest = s * materialAfter(ply.fenBefore, best, HORIZON)
  const lost = Math.round(start - viaRefutation)
  const missed = Math.round(viaBest - start)
  const diff = Math.round(viaBest - viaRefutation)
  const losesMaterial = lost >= 1 && diff >= 1
  const missesMaterial = missed >= 1 && diff >= 1

  // Why the played move is bad
  let text: string
  if (afterMate !== undefined && afterMate < 0) {
    text = t('This allows {opponent} to force mate in {n}: {line}.', { opponent, n: Math.abs(Math.round(afterMate)), line: refLine })
  } else if (beforeMate !== undefined && beforeMate > 0 && (afterMate === undefined || afterMate <= 0)) {
    text = t('{mover} had a forced mate in {n} starting with {move}: {line}.', { mover, n: Math.round(beforeMate), move, line: bestLine })
  } else if (losesMaterial) {
    text = t('This loses {material} {swing}. {opponent} answers {line}.', { material: materialWords(Math.max(lost, diff)), swing, opponent, line: refLine })
  } else if (missesMaterial) {
    text = t('This misses a chance to win {material} with {move} {swing}: {line}.', { material: materialWords(missed), move, swing, line: bestLine })
  } else {
    text = t('The position goes from {from} to {to} {swing}. {move} was stronger: {line}.', {
      from: evalWords(before.score),
      to: evalWords(after.score),
      swing,
      move,
      line: bestLine,
    })
  }

  // What the better move achieves instead, from the mover's point of view
  const moverWin = ply.color === 'w' ? winPercent(before.score) : 100 - winPercent(before.score)
  const outcome = t('{before} ({beforeScore}) instead of {after} ({afterScore}) after {played}', {
    before: evalWords(before.score),
    beforeScore: formatScore(before.score),
    after: evalWords(after.score),
    afterScore: formatScore(after.score),
    played: ply.san,
  })
  const keeps = moverWin >= 45 ? t('keeps the position {outcome}', { outcome }) : t('limits the damage: {outcome}', { outcome })
  let bestNote: string
  if (beforeMate !== undefined && beforeMate > 0) {
    bestNote = t('{move} forces mate in {n}: {line}.', { move, n: Math.round(beforeMate), line: bestLine })
  } else if (missesMaterial) {
    bestNote = t('{move} wins {material} and {keeps}: {line}.', { move, material: materialWords(missed), keeps, line: bestLine })
  } else if (losesMaterial) {
    const saves = missed <= -1 ? t('gives up less material') : t('avoids losing material')
    bestNote = t('{move} {saves} and {keeps}: {line}.', { move, saves, keeps, line: bestLine })
  } else {
    bestNote = t('{move} {keeps}: {line}.', { move, keeps, line: bestLine })
  }

  return { text, bestText: bestNote, refutation, best }
}

// --- Whole-game summary ------------------------------------------------------

export type Phase = 'opening' | 'middlegame' | 'endgame'

export function phaseOf(fen: string, plyIndex: number): Phase {
  let pieces = 0
  for (const row of new Chess(fen).board()) for (const sq of row) if (sq && sq.type !== 'p' && sq.type !== 'k') pieces++
  if (pieces <= 6) return 'endgame'
  if (plyIndex < 20 && pieces > 10) return 'opening'
  return 'middlegame'
}

/** Translated phase name ("opening" / "öppning"). */
export const phaseName = (p: Phase) => t(p)
/** Definite form ("the opening" / "öppningen"). */
export const phaseThe = (p: Phase) => t(`the ${p}`)

export interface GameSummary {
  paragraphs: string[]
  phases: { phase: Phase; w: number | null; b: number | null }[]
  moments: { ply: number; label: Label; text: string }[] // ply = 1-based index into the mainline
}

export type AccuracyRating = 'excellent' | 'good' | 'inaccurate' | 'poor'

/** Accuracy band (also used as a CSS class); show it with ratingName(). */
export function rating(acc: number): AccuracyRating {
  if (acc >= 90) return 'excellent'
  if (acc >= 80) return 'good'
  if (acc >= 65) return 'inaccurate'
  return 'poor'
}

export const ratingName = (r: AccuracyRating) => t({ excellent: 'Excellent', good: 'Good', inaccurate: 'Inaccurate', poor: 'Poor' }[r])

export function summarizeGame(game: Game, review: Review): GameSummary {
  const { white, black, result, opening } = game.meta
  const name = (c: 'w' | 'b') => (c === 'w' ? white : black)
  const acc = review.accuracy
  const paragraphs: string[] = []

  // Overview
  const winner: 'w' | 'b' | null = result === '1-0' ? 'w' : result === '0-1' ? 'b' : null
  const other = (c: 'w' | 'b') => (c === 'w' ? 'b' : 'w')
  const pct = (c: 'w' | 'b') => `${acc[c].toFixed(0)}%`
  const inOpening = opening ? t(' in the {opening}', { opening }) : ''
  if (winner) {
    const loser = other(winner)
    const verdict =
      acc[winner] >= acc[loser] - 3
        ? t("with {pct} accuracy against {loser}'s {loserPct}", { pct: pct(winner), loser: name(loser), loserPct: pct(loser) })
        : t('despite lower accuracy ({pct} vs {loserPct})', { pct: pct(winner), loserPct: pct(loser) })
    paragraphs.push(t('{winner} won{inOpening} {verdict}.', { winner: name(winner), inOpening, verdict }))
  } else {
    const outcome = result === '*' ? t('The game is unfinished') : t('The game was drawn')
    paragraphs.push(t('{outcome}{inOpening}. Accuracy: {white} {whitePct}, {black} {blackPct}.', { outcome, inOpening, white, whitePct: pct('w'), black, blackPct: pct('b') }))
  }

  // The story: when the winner took control for good, and the biggest swing
  const story: string[] = []
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
      story.push(t('{name} took a decisive advantage after {move} and never let it go.', { name: winnerIsWhite ? white : black, move: moveName(game, from - 1) }))
    } else if (from === wins.length - 1) {
      story.push(t('The game was decided by the very last move.'))
    } else if (from === -1) {
      story.push(t('The final position was not yet decisive, so the game was likely decided on time.'))
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
      t('The turning point was {move}, {label} that cost {name} about {n}% winning chances.', {
        move: moveName(game, worst),
        label: labelWithArticle(m.label),
        name: name(game.plies[worst].color),
        n: Math.round(m.winLoss),
      }),
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
