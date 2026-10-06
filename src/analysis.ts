import { Chess } from 'chess.js'
import type { Engine, Limits, Score } from './engine'

export interface GameMeta {
  white: string
  black: string
  whiteElo?: string
  blackElo?: string
  result: string
  date?: string
  event?: string
  opening?: string
  site?: string
}

export interface Ply {
  san: string
  uci: string
  fenBefore: string
  fenAfter: string
  color: 'w' | 'b'
}

export interface Game {
  meta: GameMeta
  startFen: string
  plies: Ply[]
}

export type Label = 'best' | 'good' | 'inaccuracy' | 'mistake' | 'blunder'

export const GLYPH: Record<Label, string> = { best: '★', good: '', inaccuracy: '?!', mistake: '?', blunder: '??' }

export interface PositionEval {
  score: Score
  bestMove: string | null
  pv: string[]
}

export interface MoveReview {
  label: Label
  winLoss: number // win% lost by the mover, 0..100
  accuracy: number // 0..100
  bestSan: string | null
}

export interface Review {
  evals: PositionEval[] // one per position: index 0 = start, i = after ply i
  moves: MoveReview[] // one per ply
  accuracy: { w: number; b: number }
  acpl: { w: number; b: number } // average centipawn loss
  rating: { w: RatingEstimate; b: RatingEstimate }
  counts: { w: Record<Label, number>; b: Record<Label, number> }
}

export interface RatingEstimate {
  value: number
  reliable: boolean // false for very short games
}

export function parseGame(pgn: string): Game {
  const chess = new Chess()
  chess.loadPgn(pgn.trim())
  // PGN uses "?" for unknown header values; treat those as missing.
  const h = Object.fromEntries(Object.entries(chess.header()).filter(([, v]) => v && !/^[?.]+$/.test(v))) as Record<string, string | undefined>
  const history = chess.history({ verbose: true })
  const startFen = history[0]?.before ?? chess.fen()
  return {
    meta: {
      white: h.White ?? 'White',
      black: h.Black ?? 'Black',
      whiteElo: h.WhiteElo ?? undefined,
      blackElo: h.BlackElo ?? undefined,
      result: h.Result ?? '*',
      date: h.Date ?? h.UTCDate ?? undefined,
      event: h.Event ?? undefined,
      opening: h.Opening ?? openingFromEco(h.ECOUrl),
      site: h.Site ?? h.Link ?? undefined,
    },
    startFen,
    plies: history.map((m) => ({
      san: m.san,
      uci: m.from + m.to + (m.promotion ?? ''),
      fenBefore: m.before,
      fenAfter: m.after,
      color: m.color,
    })),
  }
}

function openingFromEco(url?: string | null) {
  const slug = url?.split('/openings/')[1]
  return slug ? decodeURIComponent(slug).replace(/-/g, ' ') : undefined
}

/** Lichess' centipawn -> win% curve, from White's perspective. */
export function winPercent(score: Score): number {
  if (score.mate !== undefined) return score.mate > 0 ? 100 : score.mate < 0 ? 0 : 50
  const cp = Math.max(-1000, Math.min(1000, score.cp))
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1)
}

function moveAccuracy(winLoss: number) {
  return Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * winLoss) - 3.1669))
}

function labelFor(winLoss: number, playedBest: boolean): Label {
  if (playedBest) return 'best'
  if (winLoss >= 20) return 'blunder'
  if (winLoss >= 10) return 'mistake'
  if (winLoss >= 5) return 'inaccuracy'
  if (winLoss < 1) return 'best'
  return 'good'
}

/** Game accuracy: blend of mean and harmonic mean, which punishes a few big errors like Lichess does. */
export function aggregateAccuracy(values: number[]) {
  if (values.length === 0) return 100
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  const harmonic = values.length / values.reduce((a, b) => a + 1 / Math.max(b, 1), 0)
  return (mean + harmonic) / 2
}

export function uciToSan(fen: string, uci: string): string | null {
  try {
    const chess = new Chess(fen)
    return chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }).san
  } catch {
    return null
  }
}

export function pvToSan(fen: string, pv: string[], max = 10): string[] {
  const chess = new Chess(fen)
  const out: string[] = []
  for (const uci of pv.slice(0, max)) {
    try {
      out.push(chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }).san)
    } catch {
      break
    }
  }
  return out
}

/** Evaluation for positions where the game is already over (the engine has no move to give). */
function terminalEval(fen: string): PositionEval | null {
  const chess = new Chess(fen)
  if (chess.isCheckmate()) return { score: { mate: chess.turn() === 'w' ? -0.5 : 0.5 }, bestMove: null, pv: [] }
  if (chess.isDraw() || chess.isStalemate()) return { score: { cp: 0 }, bestMove: null, pv: [] }
  return null
}

export async function reviewGame(
  game: Game,
  engine: Engine,
  limits: Limits,
  onProgress: (done: number, total: number, evals: PositionEval[]) => void,
  isCancelled: () => boolean,
): Promise<Review | null> {
  const fens = [game.startFen, ...game.plies.map((p) => p.fenAfter)]
  const evals: PositionEval[] = []
  for (const fen of fens) {
    if (isCancelled()) return null
    const terminal = terminalEval(fen)
    if (terminal) evals.push(terminal)
    else {
      const r = await engine.analyze(fen, limits)
      evals.push({ score: r.score, bestMove: r.bestMove, pv: r.pv })
    }
    onProgress(evals.length, fens.length, [...evals])
  }
  if (isCancelled()) return null

  const empty = (): Record<Label, number> => ({ best: 0, good: 0, inaccuracy: 0, mistake: 0, blunder: 0 })
  const counts = { w: empty(), b: empty() }
  const accs: { w: number[]; b: number[] } = { w: [], b: [] }

  const cpLosses: { w: number[]; b: number[] } = { w: [], b: [] }

  const moves = game.plies.map((ply, i) => {
    const before = winPercent(evals[i].score)
    const after = winPercent(evals[i + 1].score)
    const sign = ply.color === 'w' ? 1 : -1
    const winLoss = Math.max(0, sign * (before - after))
    const playedBest = evals[i].bestMove === ply.uci
    const label = labelFor(winLoss, playedBest)
    const accuracy = playedBest ? 100 : moveAccuracy(winLoss)
    counts[ply.color][label]++
    accs[ply.color].push(accuracy)
    cpLosses[ply.color].push(playedBest ? 0 : Math.max(0, sign * (centipawns(evals[i].score) - centipawns(evals[i + 1].score))))
    const bestSan = evals[i].bestMove ? uciToSan(ply.fenBefore, evals[i].bestMove!) : null
    return { label, winLoss, accuracy, bestSan }
  })

  const accuracy = { w: aggregateAccuracy(accs.w), b: aggregateAccuracy(accs.b) }
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
  const acpl = { w: mean(cpLosses.w), b: mean(cpLosses.b) }
  const rating = {
    w: estimateRating(acpl.w, cpLosses.w.length),
    b: estimateRating(acpl.b, cpLosses.b.length),
  }
  return { evals, moves, accuracy, acpl, rating, counts }
}

/** Centipawns from White's view, with mates and huge evals capped at ±1000 (as Lichess does for ACPL). */
function centipawns(score: Score) {
  if (score.mate !== undefined) return score.mate > 0 ? 1000 : -1000
  return Math.max(-1000, Math.min(1000, score.cp))
}

/**
 * Median average centipawn loss by rating, measured on 79 Chess.com rapid games (158 player-games,
 * ratings ~100-2700, Oct 2026) reviewed with this app's engine and depth. Pairs of [ACPL, rating].
 * Interpolating between them means a typical game at rating R maps back to about R.
 */
const ACPL_BY_RATING: [number, number][] = [
  [17, 2600],
  [26, 2200],
  [39, 1800],
  [50, 1400],
  [63, 1000],
  [79, 600],
  [157, 200],
]

/** Rough "played like" rating for one side of one game; single games still vary by several hundred points. */
export function estimateRating(acpl: number, moves: number): RatingEstimate {
  const t = ACPL_BY_RATING
  const x = Math.log(Math.max(acpl, 1))
  let i = t.findIndex(([a]) => Math.log(a) >= x)
  if (i <= 0) i = i === 0 ? 1 : t.length - 1 // extrapolate from the end segments
  const [a0, r0] = t[i - 1]
  const [a1, r1] = t[i]
  const r = r0 + ((x - Math.log(a0)) / (Math.log(a1) - Math.log(a0))) * (r1 - r0)
  const value = Math.max(100, Math.min(3000, r))
  return { value: Math.round(value / 50) * 50, reliable: moves >= 15 }
}

export function formatScore(score: Score): string {
  if (score.mate !== undefined) {
    if (Math.abs(score.mate) < 1) return score.mate > 0 ? '1-0' : '0-1'
    return `${score.mate > 0 ? '' : '-'}M${Math.abs(score.mate)}`
  }
  const v = score.cp / 100
  return `${v > 0 ? '+' : ''}${v.toFixed(1)}`
}
