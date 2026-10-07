// Light gamification for puzzles: a daily goal, a day streak and the best run of correct answers.
// Kept per device in localStorage; losing it only resets the counters.

export const DAILY_GOAL = 5

export interface PuzzleStats {
  day: string // local date the "today" counter belongs to (YYYY-MM-DD)
  today: number // puzzles solved correctly today
  streak: number // consecutive days with at least one correct solve, ending on lastDay
  lastDay: string | null
  bestCombo: number // longest run of correct answers in a row
}

const KEY = 'chess-analyzer:puzzle-stats'
const dayOf = (t: number) => new Date(t).toLocaleDateString('sv-SE') // YYYY-MM-DD in local time
const yesterdayOf = (t: number) => dayOf(t - 86_400_000)

export function loadPuzzleStats(now = Date.now()): PuzzleStats {
  let s: PuzzleStats = { day: dayOf(now), today: 0, streak: 0, lastDay: null, bestCombo: 0 }
  try {
    const saved = localStorage.getItem(KEY)
    if (saved) s = { ...s, ...JSON.parse(saved) }
  } catch {
    /* storage unavailable */
  }
  if (s.day !== dayOf(now)) s = { ...s, day: dayOf(now), today: 0 }
  // A streak only counts if it reaches today or yesterday.
  if (s.lastDay !== dayOf(now) && s.lastDay !== yesterdayOf(now)) s = { ...s, streak: 0 }
  return s
}

export function recordPuzzle(s: PuzzleStats, correct: boolean, combo: number, now = Date.now()): PuzzleStats {
  const today = dayOf(now)
  let next = { ...s, bestCombo: Math.max(s.bestCombo, combo) }
  if (correct) {
    next = {
      ...next,
      day: today,
      today: (s.day === today ? s.today : 0) + 1,
      streak: s.lastDay === today ? s.streak : s.lastDay === yesterdayOf(now) ? s.streak + 1 : 1,
      lastDay: today,
    }
  }
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    /* storage unavailable */
  }
  return next
}
