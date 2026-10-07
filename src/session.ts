// Remembers the open game and its review on this device, so a reload (e.g. a phone browser
// discarding a background tab) brings you back to where you were without re-running the review.
import { parseGame, rateReview, type Game, type Review } from './analysis'

const KEY = 'chess-analyzer:session:v1'

export interface Session {
  pgn: string
  ply: number
  orientation: 'white' | 'black'
  tab: 'summary' | 'moves'
  review: Review | null
  deepDone: boolean
}

export interface RestoredSession extends Session {
  game: Game
}

export function restoreSession(): RestoredSession | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const s = JSON.parse(raw) as Session
    const game = parseGame(s.pgn)
    // Only trust a stored review that matches the game it was made for.
    const review = s.review && s.review.evals?.length === game.plies.length + 1 ? rateReview(s.review, game) : null
    return {
      ...s,
      game,
      review,
      deepDone: !!review && s.deepDone,
      ply: Math.max(0, Math.min(game.plies.length, s.ply || 0)),
    }
  } catch {
    return null
  }
}

export function saveSession(s: Session) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s))
  } catch {
    /* storage full or unavailable: the app still works, it just won't survive a reload */
  }
}
