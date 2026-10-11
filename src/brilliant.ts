// Brilliant moves (!!), in the spirit of Chess.com: a sound sacrifice. The move leaves material for the taking
// (a piece, not just a pawn, still lost after one recapture), yet the engine rates it as best or nearly best,
// the mover is not worse afterwards, and was not already completely winning (where sacrifices are routine),
// unless the sacrifice forces mate.
// Derived from the stored review, so it also works for games reviewed before this existed.
import { Chess } from 'chess.js'
import { winPercent, type Game, type MoveReview, type Ply, type PositionEval, type Review } from './analysis'
import { material } from './explain'

const MAX_WIN_LOSS = 2 // win% the move may lose and still count as (nearly) best
const MIN_SACRIFICE = 2 // pawns of material given up, after one recapture
const MIN_WIN_AFTER = 45 // the mover's win% after the move: sound, not a desperate try in a lost position
const MAX_WIN_BEFORE = 97 // already totally winning: sacrifices there are routine

export function isBrilliant(ply: Ply, rv: MoveReview, before: PositionEval, after: PositionEval): boolean {
  if (rv.winLoss > MAX_WIN_LOSS) return false
  const moverWin = (e: PositionEval) => (ply.color === 'w' ? winPercent(e.score) : 100 - winPercent(e.score))
  // A sacrifice that forces mate counts even when the mover was already winning (e.g. Morphy's 16.Qb8+)
  const forcesMate = after.score.mate !== undefined && (ply.color === 'w' ? after.score.mate > 0 : after.score.mate < 0)
  if (moverWin(after) < MIN_WIN_AFTER || (moverWin(before) > MAX_WIN_BEFORE && !forcesMate)) return false
  return sacrificed(ply) >= MIN_SACRIFICE
}

/**
 * Material the move newly puts en prise, from the mover's view: how much worse the opponent's most damaging
 * capture of a piece (not a pawn, after the mover's best recapture) is after the move than it already was
 * before it. A piece that was hanging anyway is not a sacrifice by this move.
 */
function sacrificed(ply: Ply): number {
  const s = ply.color === 'w' ? 1 : -1
  const after = afterBestCapture(new Chess(ply.fenAfter), s)
  // Before the move, as if the opponent were to move (a "null move"); not possible when the mover is in check
  const before = new Chess(ply.fenBefore)
  let already = s * material(before)
  if (!before.inCheck()) {
    const [board, turn, castling, , half, full] = ply.fenBefore.split(' ')
    try {
      already = afterBestCapture(new Chess([board, turn === 'w' ? 'b' : 'w', castling, '-', half, full].join(' ')), s)
    } catch {
      /* not a valid position with the other side to move: compare with the material as it is */
    }
  }
  return already - after
}

/** The mover's material (sign s) after the opponent's most damaging piece capture and the best recapture on that square. */
function afterBestCapture(chess: Chess, s: number): number {
  let worst = s * material(chess)
  for (const capture of chess.moves({ verbose: true })) {
    if (!capture.captured || capture.captured === 'p') continue
    chess.move(capture)
    let best = s * material(chess)
    for (const recapture of chess.moves({ verbose: true })) {
      if (recapture.to !== capture.to) continue
      chess.move(recapture)
      best = Math.max(best, s * material(chess))
      chess.undo()
    }
    chess.undo()
    worst = Math.min(worst, best)
  }
  return worst
}

/** Indexes (0-based ply) of the brilliant moves in a reviewed game; book moves never count. */
export function brilliantMoves(game: Game, review: Review, bookPlies: number): Set<number> {
  const out = new Set<number>()
  game.plies.forEach((ply, i) => {
    if (i >= bookPlies && isBrilliant(ply, review.moves[i], review.evals[i], review.evals[i + 1])) out.add(i)
  })
  return out
}
