// Maia-1 (CSSLab, GPL-3.0): neural networks trained on Lichess games to predict the move a human at a given
// rating plays, one network per 100 points from 1100 to 1900 (Lichess ratings).
import type { MaiaRequest, MaiaResponse } from './worker'

export const MAIA_RATINGS = [1100, 1200, 1300, 1400, 1500, 1600, 1700, 1800, 1900]

/** The network for a Lichess rating, or null above the range (Maia doesn't play like stronger players). */
export function maiaRating(lichess: number): number | null {
  if (lichess > 2050) return null
  return Math.min(1900, Math.max(1100, Math.round(lichess / 100) * 100))
}

let worker: Worker | null = null
let nextId = 0
const pending = new Map<number, { resolve: (m: { uci: string; p: number }[]) => void; reject: (e: Error) => void }>()

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (e: MessageEvent<MaiaResponse>) => {
      const p = pending.get(e.data.id)
      if (!p) return
      pending.delete(e.data.id)
      if ('error' in e.data) p.reject(new Error(e.data.error))
      else p.resolve(e.data.moves)
    }
    worker.onerror = (e) => {
      for (const p of pending.values()) p.reject(new Error(e.message || 'Maia failed'))
      pending.clear()
      worker?.terminate()
      worker = null
    }
  }
  return worker
}

/** How likely a player at `rating` is to play each legal move, most likely first. */
export function maiaMoves(history: string[], rating: number): Promise<{ uci: string; p: number }[]> {
  return new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    getWorker().postMessage({ id, rating, history: history.slice(-8) } satisfies MaiaRequest)
  })
}

/**
 * Picks a move the way a player at the rating might: in proportion to its probability, leaving out the very
 * unlikely ones (under 2%), which are mostly noise.
 */
export function pickMaiaMove(moves: { uci: string; p: number }[], random = Math.random): string | null {
  const likely = moves.filter((m) => m.p >= 0.02)
  const pool = likely.length ? likely : moves.slice(0, 1)
  let r = random() * pool.reduce((a, m) => a + m.p, 0)
  for (const m of pool) {
    r -= m.p
    if (r < 0) return m.uci
  }
  return pool.at(-1)?.uci ?? null
}
