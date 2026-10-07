// Reviewed games kept in IndexedDB (localStorage is too small for dozens of reviews), so each game is
// only analyzed once. Everything stays in this browser.
import type { Review } from './analysis'
import type { GameSummary } from './imports'

export interface StoredGame extends GameSummary {
  key: string // `${source}:${id}`
  review: Review
  reviewedAt: number
  engine?: string // REVIEW_ENGINE that produced the review; missing on the first cached reviews (same engine)
}

const DB_NAME = 'chess-analyzer'
const STORE = 'games'
const PROGRESS = 'puzzleProgress'

let dbPromise: Promise<IDBDatabase> | null = null

function db(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2)
    req.onupgradeneeded = () => {
      const d = req.result
      if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: 'key' })
      if (!d.objectStoreNames.contains(PROGRESS)) d.createObjectStore(PROGRESS, { keyPath: 'id' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

function run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>, storeName = STORE): Promise<T> {
  return db().then(
    (d) =>
      new Promise<T>((resolve, reject) => {
        const req = fn(d.transaction(storeName, mode).objectStore(storeName))
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

/** Spaced-repetition state for one puzzle (see puzzles.ts). */
export interface PuzzleProgress {
  id: string
  box: number // 0 = new or missed; each correct solve moves it up one box
  due: number // epoch ms when it should come back
  attempts: number
  solves: number
  lastSeen: number
}

export function allPuzzleProgress() {
  return run<PuzzleProgress[]>('readonly', (s) => s.getAll(), PROGRESS)
}

export function putPuzzleProgress(p: PuzzleProgress) {
  return run('readwrite', (s) => s.put(p), PROGRESS)
}
