// Great moves (!): the only good move in the position. Every alternative is clearly worse, so finding it
// mattered. Also says whether it was hard to spot: a quiet backward move, or one the engine itself only settles
// on late in its search (a shallow search is no human proxy: Stockfish's network sees most moves at once).
import { Chess } from 'chess.js'
import { formatScore, REVIEW_LIMITS, uciToSan, winPercent, type Game, type Ply, type Review } from './analysis'
import type { Engine, Score } from './engine'

export interface GreatMove {
  /** The best alternative and its score (White's view), to show how much worse it is. */
  nextSan: string
  nextScore: Score
  /** Win% the best alternative would lose compared with the move played. */
  gap: number
  /** The engine only settled on the move at a high depth: it takes calculation, not a glance, to find. */
  lateFind: boolean
  /** Not a capture, check or promotion, and the piece moves back towards its own side. */
  quietRetreat: boolean
}

export const MIN_GAP = 12 // the best alternative would be at least a mistake (10%), with a little margin
const MIN_WIN_AFTER = 30 // an only move in a lost position changes nothing
const MAX_ALT_WIN = 70 // if the best alternative still clearly wins, the move was not the *only* good one
// Settling on the move at this depth or later counts as hard to find. Stockfish's network sees most moves at
// depth 1-2; subtle only-moves (e.g. Saavedra's 5.Kc2) settle around 6.
const LATE_DEPTH = 6

/**
 * Whether the move played was the only good one, from the best and second-best engine lines before it.
 * `foundAtDepth` is the depth from which the engine kept preferring the move (null when unknown).
 */
export function judgeGreat(
  ply: Ply,
  prevPly: Ply | undefined,
  best: { score: Score; move: string | null },
  second: { score: Score; move: string } | null,
  foundAtDepth: number | null,
): GreatMove | null {
  if (!second || best.move !== ply.uci) return null
  const chess = new Chess(ply.fenBefore)
  if (chess.moves().length < 2) return null
  const move = chess.move({ from: ply.uci.slice(0, 2), to: ply.uci.slice(2, 4), promotion: ply.uci[4] })
  // Taking back a piece that was just captured is the obvious move, not a great one
  if (move.captured && prevPly?.san.includes('x') && prevPly.uci.slice(2, 4) === ply.uci.slice(2, 4)) return null
  const mover = (s: Score) => (ply.color === 'w' ? winPercent(s) : 100 - winPercent(s))
  const gap = mover(best.score) - mover(second.score)
  if (gap < MIN_GAP || mover(best.score) < MIN_WIN_AFTER || mover(second.score) >= MAX_ALT_WIN) return null
  if (move.san.includes('#')) return null // mate in one is its own reward
  const quiet = !move.captured && !move.promotion && !move.san.includes('+')
  const fromRank = Number(ply.uci[1])
  const toRank = Number(ply.uci[3])
  const retreat = ply.color === 'w' ? toRank < fromRank : toRank > fromRank
  return {
    nextSan: uciToSan(ply.fenBefore, second.move) ?? second.move,
    nextScore: second.score,
    gap,
    lateFind: (foundAtDepth ?? 0) >= LATE_DEPTH,
    quietRetreat: quiet && retreat,
  }
}

/**
 * Background pass over a reviewed game: for each move that matched the engine's best move, look at the
 * second-best line (needs an engine with MultiPV 2) and the depth the engine settled on the move at.
 * Returns ply index -> great move.
 */
export async function findGreatMoves(game: Game, review: Review, engine: Engine, isCancelled: () => boolean): Promise<Record<number, GreatMove> | null> {
  const out: Record<number, GreatMove> = {}
  for (let i = 0; i < game.plies.length; i++) {
    const ply = game.plies[i]
    if (review.evals[i].bestMove !== ply.uci) continue
    let lines: { depth: number; score: Score; pv: string[] }[] = []
    let top: string | undefined
    let since = 0 // depth from which the current top move has stayed on top
    await engine.analyze(ply.fenBefore, REVIEW_LIMITS, (l) => {
      lines = l
      if (l[0]?.pv[0] !== top) {
        top = l[0]?.pv[0]
        since = l[0]?.depth ?? 0
      }
    })
    if (isCancelled()) return null
    if (lines.length < 2 || !lines[1]?.pv.length) continue
    const g = judgeGreat(ply, game.plies[i - 1], { score: lines[0].score, move: lines[0].pv[0] }, { score: lines[1].score, move: lines[1].pv[0] }, since)
    if (g) out[i] = g
  }
  return out
}

/** "Only good move: Nf3 instead (+0.3) would lose 25% winning chances." plus how hard it was to spot. */
export function greatText(g: GreatMove, t: (s: string, p?: Record<string, string | number>) => string): { only: string; hard: string | null } {
  const only = t('The only good move. The best alternative, {move} ({score}), would cost about {n}% winning chances.', {
    move: g.nextSan,
    score: formatScore(g.nextScore),
    n: Math.round(g.gap),
  })
  const hard =
    g.lateFind && g.quietRetreat
      ? t('Hard to spot: a quiet backward move that only shows its point when you look deeper.')
      : g.lateFind
        ? t('Hard to spot: even the engine first preferred other moves; its point only shows when you look deeper.')
        : g.quietRetreat
          ? t('Not obvious: a quiet backward move.')
          : null
  return { only, hard }
}
