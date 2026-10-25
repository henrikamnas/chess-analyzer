// How hard a move was to find for a player of the mover's rating: Maia predicts how often players at that
// rating play each move, and the engine says which of those moves are good. A mistake most players at the
// level avoid is one to learn from; a good move few of them find is a real achievement.
import { Chess } from 'chess.js'
import { lichessRating } from './explorer'
import { maiaMoves, maiaRating } from './maia'
import { winPercent, type Game, type Review } from './analysis'
import type { Engine } from './engine'

export interface Findability {
  /** The rating the shares are for, on the game's own scale (the player's rating, or the review's estimate). */
  level: number
  /** Share of players at that level who play a good move here (one that loses under 5% winning chances). */
  good: number
  /** Share who play the move that was played. */
  played: number
}

const GOOD_LOSS = 5 // win% a move may lose and still count as good (the 'good' label's upper bound)
const MIN_SHARE = 0.02 // moves rarer than this are left out (counted as not found): mostly noise
const MAX_CANDIDATES = 6
const CANDIDATE_DEPTH = 12

/** The mover's rating on the game's scale and as a Lichess rating, from the header or else the review's estimate. */
export function playerLevel(game: Game, review: Review, color: 'w' | 'b'): { level: number; lichess: number } {
  const elo = Number(color === 'w' ? game.meta.whiteElo : game.meta.blackElo)
  if (elo > 0) return { level: elo, lichess: game.meta.platform === 'lichess' ? elo : lichessRating(elo) }
  const est = review.rating[color]
  return { level: est.value, lichess: est.basis.startsWith('lichess') ? est.value : lichessRating(est.value) }
}

/**
 * Background pass over a reviewed game: for every move, how many players at the mover's level would find a
 * good move, and how many would play the move that was played. Moves by players above Maia's range (about
 * Chess.com 1850) are skipped. Returns ply index -> findability.
 */
export async function findFindability(game: Game, review: Review, engine: Engine, isCancelled: () => boolean): Promise<Record<number, Findability> | null> {
  const out: Record<number, Findability> = {}
  const levels = { w: playerLevel(game, review, 'w'), b: playerLevel(game, review, 'b') }
  const fens = [game.startFen, ...game.plies.map((p) => p.fenAfter)]
  for (let i = 0; i < game.plies.length; i++) {
    const ply = game.plies[i]
    const net = maiaRating(levels[ply.color].lichess)
    const before = review.evals[i]
    const after = review.evals[i + 1]
    if (!net || !before || !after) continue
    let moves: { uci: string; p: number }[]
    try {
      moves = await maiaMoves(fens.slice(Math.max(0, i - 7), i + 1), net)
    } catch {
      return null // Maia didn't load: an optional extra, so give up quietly
    }
    if (isCancelled()) return null
    if (moves.length < 2) continue
    const mover = (s: Parameters<typeof winPercent>[0]) => (ply.color === 'w' ? winPercent(s) : 100 - winPercent(s))
    // Each likely move's winning chances: the review already has the best and the played move
    const scored: { uci: string; p: number; win: number }[] = []
    for (const m of moves.filter((m) => m.p >= MIN_SHARE).slice(0, MAX_CANDIDATES)) {
      let win: number
      if (m.uci === ply.uci) win = mover(after.score)
      else if (m.uci === before.bestMove) win = mover(before.score)
      else {
        const next = new Chess(ply.fenBefore)
        next.move({ from: m.uci.slice(0, 2), to: m.uci.slice(2, 4), promotion: m.uci[4] })
        const r = await engine.analyze(next.fen(), { depth: CANDIDATE_DEPTH })
        if (isCancelled()) return null
        win = next.isCheckmate() ? 100 : next.isDraw() ? 50 : mover(r.score)
      }
      scored.push({ ...m, win })
    }
    const top = Math.max(mover(before.score), ...scored.map((m) => m.win))
    out[i] = {
      level: levels[ply.color].level,
      good: scored.filter((m) => top - m.win < GOOD_LOSS).reduce((a, m) => a + m.p, 0),
      played: moves.find((m) => m.uci === ply.uci)?.p ?? 0,
    }
  }
  return out
}

type T = (s: string, p?: Record<string, string | number>) => string
const pct = (x: number) => (x < 0.01 ? '<1' : String(Math.round(x * 100)))

/**
 * What the shares say about a move, by its verdict: for a mistake, whether players at the level usually find
 * something better; for the best move, whether it was a hard one to find. Null when there's nothing to tell.
 */
export function findabilityText(f: Findability, verdict: 'error' | 'best' | 'other', san: string, t: T): string | null {
  const level = f.level
  if (verdict === 'error') {
    const good = pct(f.good)
    const base =
      f.good >= 0.5
        ? t('{n}% of players rated about {level} find a good move here: one to learn from.', { n: good, level })
        : f.good >= 0.2
          ? t('{n}% of players rated about {level} find a good move here.', { n: good, level })
          : t('A hard one: only {n}% of players rated about {level} find a good move here.', { n: good, level })
    return f.played >= 0.15 ? `${base} ${t('{move} is a natural mistake: {n}% of them play it.', { move: san, n: pct(f.played) })}` : base
  }
  if (verdict === 'best' && f.played < 0.3) {
    return t('Only {n}% of players rated about {level} play {move} here.', { n: pct(f.played), level, move: san })
  }
  return null
}

/** Mistakes most players at the level avoid, and ones that were hard to avoid. */
export function missedKinds(f: Findability | undefined): 'avoidable' | 'hard' | null {
  if (!f) return null
  return f.good >= 0.5 ? 'avoidable' : f.good < 0.2 ? 'hard' : null
}
