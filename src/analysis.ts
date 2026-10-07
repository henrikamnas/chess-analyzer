import { Chess } from 'chess.js'
import type { Engine, Limits, Score } from './engine'
import type { TimeClass } from './imports'

/** Engine limits for the standard review. The rating estimate is calibrated on reviews made with these. */
export const REVIEW_LIMITS = { depth: 16 }
/** Stamp stored with cached reviews; bump it when the engine or REVIEW_LIMITS change, so they get re-reviewed. */
export const REVIEW_ENGINE = 'sf19-lite-d16'

export type Platform = 'chesscom' | 'lichess'

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
  platform?: Platform // where the game was played, from the Site header
  timeClass?: TimeClass // from the TimeControl header
}

function detectPlatform(site?: string): Platform | undefined {
  if (!site) return undefined
  if (/lichess\.org/i.test(site)) return 'lichess'
  if (/chess\.com/i.test(site)) return 'chesscom'
  return undefined
}

/** Time class the way each site defines it, from "base+increment" (estimated game length = base + 40 × increment). */
function detectTimeClass(timeControl: string | undefined, platform: Platform | undefined): TimeClass | undefined {
  if (!timeControl) return undefined
  if (timeControl === '-' || timeControl.includes('/')) return 'daily' // correspondence / daily
  const m = timeControl.match(/^(\d+)(?:\+(\d+))?$/)
  if (!m) return undefined
  const est = Number(m[1]) + 40 * Number(m[2] ?? 0)
  if (platform === 'lichess') return est < 180 ? 'bullet' : est < 480 ? 'blitz' : est < 1500 ? 'rapid' : 'classical'
  return est < 180 ? 'bullet' : est < 600 ? 'blitz' : 'rapid'
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
  basis: string // which players it compares with, e.g. "Chess.com blitz"
  calibrated: boolean // false when there is no table for this game type and the closest one is used instead
  precision: 'good' | 'fair' | 'rough' // how much a single game of this type says about rating
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
      platform: detectPlatform(h.Site ?? h.Link),
      timeClass: detectTimeClass(h.TimeControl, detectPlatform(h.Site ?? h.Link)),
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

/**
 * How each engine line compares with the best one, as a move label: the win% the side to move gives up by
 * choosing it instead of line 1. Line 1 is always 'best'; near-equal alternatives are 'best' too.
 */
export function lineLabels(scores: Score[], whiteToMove: boolean): Label[] {
  const forMover = (sc: Score) => (whiteToMove ? winPercent(sc) : 100 - winPercent(sc))
  const top = scores.length ? forMover(scores[0]) : 50
  return scores.map((sc, i) => {
    if (i === 0) return 'best'
    const loss = Math.max(0, top - forMover(sc))
    if (loss >= 20) return 'blunder'
    if (loss >= 10) return 'mistake'
    if (loss >= 5) return 'inaccuracy'
    return loss < 2 ? 'best' : 'good'
  })
}

/** Centipawns for the side to move; mates count as huge values so they compare correctly. */
function moverCp(score: Score, whiteToMove: boolean) {
  const cp = score.mate !== undefined ? Math.sign(score.mate) * (100000 - Math.abs(score.mate) * 100) : score.cp
  return whiteToMove ? cp : -cp
}

/**
 * How much worse an engine line is than the best one, for the side to move.
 * short: panel text ("−1.8", "=", "allows mate", "misses mate"); badge: compact arrow text ("−1.8", "#", "−#").
 */
export function lineCost(best: Score, line: Score, whiteToMove: boolean): { short: string; badge: string | null; long: string } {
  const b = moverCp(best, whiteToMove)
  const l = moverCp(line, whiteToMove)
  const isMate = (cp: number) => Math.abs(cp) >= 50000
  if (isMate(l) && l < 0 && !(isMate(b) && b < 0)) return { short: 'allows mate', badge: '#', long: 'This line allows a forced mate' }
  if (isMate(b) && b > 0 && !(isMate(l) && l > 0)) return { short: 'misses mate', badge: '−#', long: 'The best line forces mate; this one does not' }
  const diff = Math.max(0, b - l) / 100
  if (diff < 0.05) return { short: '=', badge: null, long: 'As good as the best line' }
  const text = `−${diff >= 10 ? Math.round(diff) : diff.toFixed(1)}`
  return { short: `−${diff.toFixed(1)}`, badge: text, long: `${diff.toFixed(1)} pawns worse than the best line` }
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
    w: estimateRating(acpl.w, cpLosses.w.length, game.meta),
    b: estimateRating(acpl.b, cpLosses.b.length, game.meta),
  }
  return { evals, moves, accuracy, acpl, rating, counts }
}

/**
 * Recomputes a stored review's rating estimates with the current tables. The estimate is derived from the
 * stored centipawn loss, so new calibrations apply to old reviews without re-analysing them.
 */
export function rateReview(review: Review, game: Game): Review {
  const moves = (c: 'w' | 'b') => game.plies.filter((p) => p.color === c).length
  return {
    ...review,
    rating: {
      w: estimateRating(review.acpl.w, moves('w'), game.meta),
      b: estimateRating(review.acpl.b, moves('b'), game.meta),
    },
  }
}

/** Centipawns from White's view, with mates and huge evals capped at ±1000 (as Lichess does for ACPL). */
function centipawns(score: Score) {
  if (score.mate !== undefined) return score.mate > 0 ? 1000 : -1000
  return Math.max(-1000, Math.min(1000, score.cp))
}

/**
 * Typical average centipawn loss by rating, per site and time class: pairs of [ACPL, rating], interpolated in
 * log-ACPL. All measured on real rated games reviewed with this app's engine and depth (REVIEW_LIMITS), Oct 2026.
 * Chess.com rapid: median ACPL per rating band (79 games). The others: a smooth fit of ln(ACPL) against rating,
 * which stays stable where a single game's ACPL says little (fast time controls).
 * Games per table: Chess.com blitz 72, bullet 72, daily 53; Lichess blitz 60, bullet 56, rapid 51.
 */
const RATING_TABLES: Record<string, [number, number][]> = {
  'chesscom:rapid': [
    [17, 2600],
    [26, 2200],
    [39, 1800],
    [50, 1400],
    [63, 1000],
    [79, 600],
    [157, 200],
  ],
  'chesscom:daily': [[9, 2700], [14, 2300], [20, 1900], [28, 1500], [41, 1100], [59, 700], [78, 400]],
  'chesscom:blitz': [[31, 2800], [35, 2400], [40, 2000], [46, 1600], [52, 1200], [60, 800], [68, 400], [73, 200]],
  'chesscom:bullet': [[34, 2800], [40, 2400], [47, 2000], [56, 1600], [66, 1200], [79, 800], [93, 400], [102, 200]],
  'lichess:rapid': [[20, 2800], [27, 2400], [36, 2000], [47, 1600], [62, 1200], [76, 900]],
  'lichess:blitz': [[24, 2800], [31, 2400], [40, 2000], [52, 1600], [67, 1200], [87, 800]],
  'lichess:bullet': [[45, 2800], [51, 2400], [59, 2000], [68, 1600], [78, 1200], [81, 1100]],
}

/**
 * How much one game says about rating, per table, from the correlation between a game's ACPL and the player's
 * rating in the calibration data: rapid/daily ~0.65, Lichess rapid/blitz ~0.55, Chess.com blitz/bullet and
 * Lichess bullet ~0.4 (fast games are noisy for everyone; averages over many games are far more telling).
 */
const TABLE_PRECISION: Record<string, 'good' | 'fair' | 'rough'> = {
  'chesscom:rapid': 'good',
  'chesscom:daily': 'good',
  'lichess:rapid': 'fair',
  'lichess:blitz': 'fair',
  'chesscom:blitz': 'rough',
  'chesscom:bullet': 'rough',
  'lichess:bullet': 'rough',
}

const PLATFORM_NAME: Record<Platform, string> = { chesscom: 'Chess.com', lichess: 'Lichess' }

/** Closest calibrated table for game types without their own (too few games to calibrate on). */
const TABLE_FALLBACK: Record<string, string> = {
  'lichess:classical': 'lichess:rapid',
  'lichess:daily': 'chesscom:daily',
}

/** Rough "played like" rating for one side of one game; single games still vary by several hundred points. */
export function estimateRating(acpl: number, moves: number, meta?: Pick<GameMeta, 'platform' | 'timeClass'>): RatingEstimate {
  const key = meta?.platform && meta.timeClass ? `${meta.platform}:${meta.timeClass}` : ''
  const calibrated = key in RATING_TABLES
  // Without a table for this game type, use the closest one we have (labelled as an equivalent).
  const used = calibrated ? key : [TABLE_FALLBACK[key], 'chesscom:rapid'].find((k) => k && k in RATING_TABLES)!
  const t = RATING_TABLES[used]
  const x = Math.log(Math.max(acpl, 1))
  let i = t.findIndex(([a]) => Math.log(a) >= x)
  if (i <= 0) i = i === 0 ? 1 : t.length - 1 // extrapolate from the end segments
  const [a0, r0] = t[i - 1]
  const [a1, r1] = t[i]
  const r = r0 + ((x - Math.log(a0)) / (Math.log(a1) - Math.log(a0))) * (r1 - r0)
  const value = Math.max(100, Math.min(3000, r))
  return {
    value: Math.round(value / 50) * 50,
    reliable: moves >= 15,
    basis: `${PLATFORM_NAME[used.split(':')[0] as Platform]} ${used.split(':')[1]}`,
    calibrated,
    precision: TABLE_PRECISION[used] ?? 'rough',
  }
}

export function formatScore(score: Score): string {
  if (score.mate !== undefined) {
    if (Math.abs(score.mate) < 1) return score.mate > 0 ? '1-0' : '0-1'
    return `${score.mate > 0 ? '' : '-'}M${Math.abs(score.mate)}`
  }
  const v = score.cp / 100
  return `${v > 0 ? '+' : ''}${v.toFixed(1)}`
}
