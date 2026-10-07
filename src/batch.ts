// Reviews a player's recent games in the background with a small pool of engines, caching each review.
import { parseGame, REVIEW_LIMITS, reviewGame } from './analysis'
import { Engine } from './engine'
import { fetchGames, type Source, type TimeClass } from './imports'
import { gameKey, getStoredGame, putStoredGame } from './store'

export interface BatchOptions {
  source: Source
  user: string
  timeClass?: TimeClass
  count: number
}

export interface BatchProgress {
  status: 'fetching' | 'reviewing' | 'done' | 'error' | 'cancelled'
  total: number // games fetched
  cached: number // already reviewed earlier
  done: number // reviewed in this run
  engines: number
  startedAt: number
  elapsedMs: number
  error?: string
}

/** Parallel engines: a few on a laptop, fewer on a phone, always leaving room for the UI. */
export function batchEngineCount() {
  return Math.max(1, Math.min(4, Math.floor((navigator.hardwareConcurrency || 2) / 2) - 1))
}

export function runBatch(
  options: BatchOptions,
  onProgress: (p: BatchProgress) => void,
  onGameStored: () => void,
): { cancel: () => void; done: Promise<void> } {
  let cancelled = false
  const engines: Engine[] = []
  const p: BatchProgress = {
    status: 'fetching',
    total: 0,
    cached: 0,
    done: 0,
    engines: 0,
    startedAt: Date.now(),
    elapsedMs: 0,
  }
  const emit = () => onProgress({ ...p, elapsedMs: Date.now() - p.startedAt })

  const done = (async () => {
    emit()
    try {
      const games = await fetchGames(options.source, options.user, { max: options.count, timeClass: options.timeClass })
      if (cancelled) return
      p.total = games.length
      const todo: typeof games = []
      for (const g of games) {
        if (await getStoredGame(gameKey(g))) p.cached++
        else todo.push(g)
      }
      p.status = 'reviewing'
      p.engines = Math.min(batchEngineCount(), todo.length)
      p.startedAt = Date.now() // time estimates only count the reviewing part
      emit()

      let next = 0
      const worker = async (engine: Engine) => {
        while (!cancelled && next < todo.length) {
          const summary = todo[next++]
          try {
            const game = parseGame(summary.pgn)
            const review = await reviewGame(game, engine, REVIEW_LIMITS, () => {}, () => cancelled)
            if (!review || cancelled) return
            await putStoredGame({ ...summary, key: gameKey(summary), review, reviewedAt: Date.now() })
            onGameStored()
          } catch (e) {
            console.warn('Skipping game', summary.id, e)
          }
          p.done++
          emit()
        }
      }
      for (let i = 0; i < p.engines; i++) engines.push(new Engine())
      await Promise.all(engines.map(worker))
      if (!cancelled) {
        p.status = 'done'
        emit()
      }
    } catch (e) {
      if (cancelled) return
      p.status = 'error'
      p.error = e instanceof Error ? e.message : String(e)
      emit()
    } finally {
      engines.forEach((e) => e.terminate())
    }
  })()

  return {
    done,
    cancel: () => {
      cancelled = true
      engines.forEach((e) => e.terminate())
      p.status = 'cancelled'
      emit()
    },
  }
}
