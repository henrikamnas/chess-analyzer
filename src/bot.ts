// A computer opponent that plays about as well as a player of a given rating.
// Stockfish's own strength limit stops at ~1320 Elo, too strong for many club players, so the bot searches
// several candidate moves and picks one at random, weighted so that on average it gives away as many
// centipawns per move as players of that rating do in real games (the ACPL tables used for rating estimates).
import { acplForRating, type GameMeta } from './analysis'
import type { Engine, EngineLine, Score } from './engine'

export const BOT_LINES = 12 // candidate moves per search

/** Rating to play at; null plays the engine's best move. */
export type BotStrength = number | null

/** Candidate values for the side to move, in centipawns; mates are just beyond the largest evals. */
function value(score: Score, whiteToMove: boolean) {
  const v = score.mate !== undefined ? Math.sign(score.mate) * (1500 - Math.min(Math.abs(score.mate), 20) * 5) : Math.max(-1400, Math.min(1400, score.cp))
  return whiteToMove ? v : -v
}

/**
 * Picks a move with weights exp(-loss / T), with T chosen so that the expected loss is `target` (the typical
 * centipawn loss per move at the bot's rating): with one bad option around, it falls for it about as often
 * as players of that rating do.
 */
export function pickMove(lines: EngineLine[], whiteToMove: boolean, target: number, random = Math.random): string | null {
  const cands = lines.filter((l) => l.pv[0])
  if (!cands.length) return null
  const vals = cands.map((l) => value(l.score, whiteToMove))
  const best = Math.max(...vals)
  const loss = vals.map((v) => best - v)
  const expected = (T: number) => {
    const w = loss.map((l) => Math.exp(-l / T))
    const z = w.reduce((a, b) => a + b, 0)
    return w.reduce((a, wi, i) => a + wi * loss[i], 0) / z
  }
  // Capped at twice the target: in a quiet position, where no move loses that much, players of every level
  // still mostly pick the sensible moves; they lose their centipawns where there is something to lose.
  // (Checked in bot-vs-bot games: uncapped the bot played weaker than its rating, capped at 1x much stronger.)
  let T = 2 * target
  if (expected(T) > target) {
    let lo = 0.1
    let hi = T
    for (let k = 0; k < 50; k++) {
      const mid = Math.sqrt(lo * hi)
      if (expected(mid) > target) hi = mid
      else lo = mid
    }
    T = lo
  }
  const weights = loss.map((l) => Math.exp(-l / T))
  let r = random() * weights.reduce((a, b) => a + b, 0)
  for (let i = 0; i < cands.length; i++) {
    r -= weights[i]
    if (r <= 0) return cands[i].pv[0]
  }
  return cands[cands.length - 1].pv[0]
}

/** Searches the position and returns the bot's move (UCI). The engine must have been created with BOT_LINES. */
export async function botMove(engine: Engine, fen: string, strength: BotStrength, meta: GameMeta): Promise<string | null> {
  // Weaker players get a shallower search: its own misjudgements are part of playing like them.
  const depth = strength === null ? 18 : strength < 1200 ? 8 : strength < 1800 ? 10 : 13
  let lines: EngineLine[] = []
  const result = await engine.analyze(fen, { depth, movetimeMs: strength === null ? 3000 : 1500 }, (l) => (lines = l))
  if (strength === null) return result.bestMove
  return pickMove(lines, fen.split(' ')[1] === 'w', acplForRating(strength, meta)) ?? result.bestMove
}
