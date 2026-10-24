// Move statistics from the Lichess open database (built by scripts/build-explorer.mjs into public/explorer):
// for each opening position, how often players in each rating band played each move, and how those games ended.
import { positionKey } from './openingHash'

/** Lichess rating bands of the player making the move: <1200, 1200–1499, 1500–1799, 1800–2099, 2100+. */
export const BANDS = [1200, 1500, 1800, 2100]

interface Meta {
  source: string
  games: number
  bands: number[]
  shardDigits: number
}

export interface MoveStat {
  uci: string
  games: number
  /** The mover's score: wins plus half the draws, as a share of the games (0–1). */
  score: number
  share: number // of all games in the position (in the band)
}

const base = `${import.meta.env.BASE_URL}explorer/`
let metaPromise: Promise<Meta | null> | null = null
const shards = new Map<string, Promise<Record<string, (string | number)[][]> | null>>()

function meta() {
  metaPromise ??= fetch(`${base}meta.json`)
    .then((r) => (r.ok ? (r.json() as Promise<Meta>) : null))
    .catch(() => null)
  return metaPromise
}

/**
 * Lichess ratings run higher than Chess.com ones, most at lower levels (roughly +540 at Chess.com 700, +450 at
 * 1000, +280 at 1500, +120 at 2000, after published comparisons of players on both sites).
 */
export function lichessRating(chessCom: number): number {
  return chessCom + Math.max(0, 760 - 0.32 * chessCom)
}

export function bandOf(lichess: number): number {
  return BANDS.filter((b) => lichess >= b).length
}

/** All moves played in a position, with counts per band: [uci, w, d, b (band 0), w, d, b (band 1), …]. */
async function rows(fen: string): Promise<(string | number)[][] | null> {
  const m = await meta()
  if (!m) return null
  const key = positionKey(fen)
  const shard = key.slice(0, m.shardDigits)
  let p = shards.get(shard)
  if (!p) {
    p = fetch(`${base}${shard}.json`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
    shards.set(shard, p)
  }
  return (await p)?.[key.slice(m.shardDigits)] ?? null
}

/**
 * How players around a band played in a position, most played first. Thin bands borrow from the neighbouring
 * ones until `minGames` games are covered, so the shares stay meaningful. Null when the position isn't in the data.
 */
export async function movesAt(fen: string, band: number, minGames = 30): Promise<MoveStat[] | null> {
  const data = await rows(fen)
  if (!data) return null
  const white = fen.split(' ')[1] === 'w'
  const nb = BANDS.length + 1
  const bandTotal = (b: number) => data.reduce((a, r) => a + (r[1 + 3 * b] as number) + (r[2 + 3 * b] as number) + (r[3 + 3 * b] as number), 0)
  const used = new Set([band])
  let total = bandTotal(band)
  for (let d = 1; total < minGames && d < nb; d++) {
    for (const b of [band - d, band + d]) {
      if (b < 0 || b >= nb) continue
      used.add(b)
      total += bandTotal(b)
    }
  }
  if (!total) return null
  const stats = data.map((r) => {
    let w = 0
    let dr = 0
    let l = 0
    for (const b of used) {
      w += r[1 + 3 * b] as number
      dr += r[2 + 3 * b] as number
      l += r[3 + 3 * b] as number
    }
    const games = w + dr + l
    const wins = white ? w : l
    return { uci: r[0] as string, games, score: games ? (wins + dr / 2) / games : 0.5, share: games / total }
  })
  return stats.filter((s) => s.games > 0).sort((a, b) => b.games - a.games)
}

/**
 * Picks a move as players at the level would, from `stats`. With `allowed` (the book moves of the opening being
 * practised) only those are played, and book moves nobody played get a small chance. `tricky` favours moves
 * that score well for the side playing them, which steers toward lines the other side tends to get wrong.
 * Null when there is too little data to go on.
 */
export function pickHumanMove(
  stats: MoveStat[] | null,
  allowed: string[] | null,
  tricky: boolean,
  random = Math.random,
): string | null {
  const total = stats?.reduce((a, s) => a + s.games, 0) ?? 0
  const byMove = new Map(stats?.map((s) => [s.uci, s]))
  const candidates = allowed ?? (total >= 50 ? stats!.filter((s) => s.games >= 3).map((s) => s.uci) : [])
  if (!candidates.length || !total) return null
  const weights = candidates.map((uci) => {
    const s = byMove.get(uci)
    let w = s ? s.games : 0
    if (allowed) w = Math.max(w, 0.005 * total)
    if (tricky && s && s.games >= 20) w *= Math.exp(8 * (s.score - 0.5))
    return w
  })
  let r = random() * weights.reduce((a, b) => a + b, 0)
  for (let i = 0; i < candidates.length; i++) {
    r -= weights[i]
    if (r < 0) return candidates[i]
  }
  return candidates.at(-1) ?? null
}

export async function explorerSource(): Promise<{ source: string; games: number } | null> {
  const m = await meta()
  return m && { source: m.source, games: m.games }
}
