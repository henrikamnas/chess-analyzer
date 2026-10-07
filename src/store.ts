// Reviewed games kept in IndexedDB (localStorage is too small for dozens of reviews), so each game is
// only analyzed once. Everything stays in this browser.
import type { Review } from './analysis'
import type { GameSummary } from './imports'

export interface StoredGame extends GameSummary {
  key: string // `${source}:${id}`
  review: Review
  reviewedAt: number
}

const DB_NAME = 'chess-analyzer'
const STORE = 'games'

let dbPromise: Promise<IDBDatabase> | null = null

function db(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'key' })
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

function run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return db().then(
    (d) =>
      new Promise<T>((resolve, reject) => {
        const req = fn(d.transaction(STORE, mode).objectStore(STORE))
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      }),
  )
}

export const gameKey = (g: Pick<GameSummary, 'source' | 'id'>) => `${g.source}:${g.id}`

export function getStoredGame(key: string) {
  return run<StoredGame | undefined>('readonly', (s) => s.get(key))
}

export function putStoredGame(game: StoredGame) {
  return run('readwrite', (s) => s.put(game))
}

export function allStoredGames() {
  return run<StoredGame[]>('readonly', (s) => s.getAll())
}

/** Stored games in which `user` played, on the given site. */
export async function storedGamesFor(user: string, source: GameSummary['source']) {
  const name = user.toLowerCase()
  return (await allStoredGames()).filter(
    (g) => g.source === source && (g.white.toLowerCase() === name || g.black.toLowerCase() === name),
  )
}
