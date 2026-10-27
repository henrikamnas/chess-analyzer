// A computer opponent that plays about as well as a player of a given rating.
// Stockfish's own strength limit stops at ~1320 Elo, too strong for many club players, so the bot searches
// several candidate moves and picks one at random, weighted so that on average it gives away as many
// centipawns per move as players of that rating do in real games (the ACPL tables used for rating estimates).
import { acplForRating, type GameMeta } from './analysis'
import type { Engine, EngineLine, Score } from './engine'

export const BOT_LINES = 12 // candidate moves per search

/** Rating to play at; null plays the engine's best move. */
export type BotStrength = number | null

/**
 * Candidate values for the side to move, in centipawns; mates are just beyond the largest evals. Big evals are
 * compressed rather than cut off, so a bot far ahead still prefers winning more (with a flat cap every move
 * looked the same to it once it was ~14 pawns up, and it played at random).
 */
function value(score: Score, whiteToMove: boolean) {
  const soft = (cp: number) => Math.sign(cp) * (Math.abs(cp) <= 1000 ? Math.abs(cp) : 1000 + 300 * Math.log(1 + (Math.abs(cp) - 1000) / 300))
  const v = score.mate !== undefined ? Math.sign(score.mate) * (3000 - Math.min(Math.abs(score.mate), 20) * 5) : soft(score.cp)
  return whiteToMove ? v : -v
}

/** Each line's first move and its loss against the best line (centipawns, for the side to move). */
function lossesOf(lines: EngineLine[], whiteToMove: boolean) {
  const vals = lines.filter((l) => l.pv[0]).map((l) => [l.pv[0], value(l.score, whiteToMove)] as const)
  const best = Math.max(...vals.map(([, v]) => v))
  const losses = new Map(vals.map(([m, v]) => [m, best - v]))
  // A move outside the lines is at least as bad as the worst of them.
  return (uci: string) => losses.get(uci) ?? Math.max(0, ...losses.values())
}

const BIG_LOSS = 200 // centipawns: dropping a piece, or a couple of pawns
const SHALLOW_DEPTH = 3 // what a quick look at the position shows

/**
 * How likely a player of a rating is to make a big mistake that even a quick look shows (leaving a piece hanging,
 * not taking a free one), relative to an equally big one that only a deeper search finds: 0.5 at 600, ~0.12
 * at 1300, ~0.05 at 1800. Players lose most of their centipawns to tactics they don't see, not ones they do.
 */
const obviousFactor = (rating: number) => Math.min(0.5, 0.5 * Math.exp(-(rating - 600) / 500))

/**
 * Picks a move with weights exp(-loss / T), with T chosen so that the expected loss is `target` (the typical
 * centipawn loss per move at the bot's rating): with one bad option around, it falls for it about as often
 * as players of that rating do. With `obvious`, big losses a shallow search already sees are weighted down
 * further, so the bot rarely drops material in plain sight and makes its mistakes in the hidden tactics instead.
 */
export function pickMove(
  lines: EngineLine[],
  whiteToMove: boolean,
  target: number,
  random = Math.random,
  obvious?: { lines: EngineLine[]; factor: number },
): string | null {
  const cands = lines.filter((l) => l.pv[0])
  if (!cands.length) return null
  const vals = cands.map((l) => value(l.score, whiteToMove))
  const best = Math.max(...vals)
  const loss = vals.map((v) => best - v)
  const shallow = obvious?.lines.length ? lossesOf(obvious.lines, whiteToMove) : null
  const prior = cands.map((l, i) => (shallow && loss[i] >= BIG_LOSS && shallow(l.pv[0]) >= BIG_LOSS ? obvious!.factor : 1))
  const expected = (T: number) => {
    const w = loss.map((l, i) => prior[i] * Math.exp(-l / T))
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
  const weights = loss.map((l, i) => prior[i] * Math.exp(-l / T))
  let r = random() * weights.reduce((a, b) => a + b, 0)
  for (let i = 0; i < cands.length; i++) {
    r -= weights[i]
    if (r <= 0) return cands[i].pv[0]
  }
  return cands[cands.length - 1].pv[0]
}

/** The engine's candidate lines (BOT_LINES of them) and best move for a position. */
async function search(engine: Engine, fen: string, depth: number, movetimeMs: number) {
  let lines: EngineLine[] = []
  const result = await engine.analyze(fen, { depth, movetimeMs }, (l) => (lines = l))
  return { lines, bestMove: result.bestMove }
}

/** Weaker players get a shallower search: its own misjudgements are part of playing like them. */
const botDepth = (strength: number) => (strength < 1200 ? 8 : strength < 1800 ? 10 : 13)

/** Searches the position and returns the bot's move (UCI). The engine must have been created with BOT_LINES. */
export async function botMove(engine: Engine, fen: string, strength: BotStrength, meta: GameMeta): Promise<string | null> {
  if (strength === null) return (await search(engine, fen, 18, 3000)).bestMove
  const shallow = await search(engine, fen, SHALLOW_DEPTH, 300)
  const { lines, bestMove } = await search(engine, fen, botDepth(strength), 1500)
  const obvious = { lines: shallow.lines, factor: obviousFactor(strength) }
  return pickMove(lines, fen.split(' ')[1] === 'w', acplForRating(strength, meta), Math.random, obvious) ?? bestMove
}

const HUMAN_SLACK = 30 // centipawns a move may lose before the engine check counts against it
const VARIED_MOVES = 6 // full moves at the start played from Maia's plain odds, so games open differently

/**
 * How strongly the bot favours Maia's likeliest moves (the exponent on their probabilities). Sampling a random
 * player's move every move plays weaker and more erratically than one player of the rating, and Maia's top
 * network (Lichess 1900) is already below the strongest levels; so 1 (plain odds) at 800, 3 at 1800 and up.
 * Weaker levels keep the plain odds, where Maia's top move alone would play above the level.
 */
export function maiaSharpness(strength: number, fen: string): number {
  if (Number(fen.split(' ')[5] ?? 1) <= VARIED_MOVES) return 1
  return Math.max(1, Math.min(3, 1 + (strength - 800) / 500))
}

/**
 * Human-like: picks from Maia's prediction for a player of the rating, with probabilities raised to `sharpness`
 * (see maiaSharpness) and scaled by exp(-loss / ACPL) for what each move loses beyond a small slack. Among
 * sensible moves the bot keeps Maia's human choices, but it takes free material and avoids dropping its own
 * about as reliably as players of that rating do. (Maia alone, sampled move by move, left a free pawn or piece
 * alone whenever a few percent of players would.)
 */
export function pickMaiaMove(
  maia: { uci: string; p: number }[],
  lines: EngineLine[],
  whiteToMove: boolean,
  target: number,
  sharpness = 1,
  random = Math.random,
): string | null {
  const pool = maia.filter((m) => m.p >= 0.02)
  if (!pool.length) return maia[0]?.uci ?? null
  const loss = lines.length ? lossesOf(lines, whiteToMove) : null
  const weights = pool.map((m) => m.p ** sharpness * (loss ? Math.exp(-Math.max(0, loss(m.uci) - HUMAN_SLACK) / target) : 1))
  let r = random() * weights.reduce((a, b) => a + b, 0)
  for (let i = 0; i < pool.length; i++) {
    r -= weights[i]
    if (r < 0) return pool[i].uci
  }
  return pool[pool.length - 1].uci
}

/** The engine check for pickMaiaMove: candidate lines at the bot's search depth for the rating. */
export async function humanCheckLines(engine: Engine, fen: string, strength: number): Promise<EngineLine[]> {
  return (await search(engine, fen, botDepth(strength), 1500)).lines
}
