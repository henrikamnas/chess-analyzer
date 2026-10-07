// Practice puzzles made from the player's own reviewed games, with simple spaced repetition.
import { parseGame, uciToSan, winPercent } from './analysis'
import type { Score } from './engine'
import { moveName } from './explain'
import { classifyTactic, describeTactic, type Tactic } from './tactics'
import type { PuzzleProgress, StoredGame } from './store'

export interface Puzzle {
  id: string // `${gameKey}:${ply}`
  gameKey: string
  ply: number // 1-based ply of the move to find (open the game at ply - 1 to see the puzzle position)
  fen: string // position to solve, the player to move
  color: 'w' | 'b'
  kind: 'punish' | 'better' // punish an opponent's blunder, or find a better move than your mistake
  best: string // engine's best move (UCI)
  bestSan: string
  line: string[] // engine line starting with the best move
  score: Score // evaluation with best play (White's view)
  playedSan: string // what was actually played
  theme: Tactic | null // tactic in the best line, if any
  allowed: Tactic | null // what the played move allowed, for "better move" puzzles
  title: string // e.g. "14... vs magnus"
  date: number
}

/** Days until a puzzle comes back after a correct solve, by box. */
const INTERVAL_DAYS = [1, 3, 7, 14, 30]
const RETRY_MS = 10 * 60 * 1000 // a missed puzzle comes back later in the same session

export function buildPuzzles(user: string, stored: StoredGame[]): Puzzle[] {
  const name = user.toLowerCase()
  const out: Puzzle[] = []
  for (const s of stored) {
    let game
    try {
      game = parseGame(s.pgn)
    } catch {
      continue
    }
    const me = s.white.toLowerCase() === name ? 'w' : 'b'
    const opp = me === 'w' ? 'b' : 'w'
    const review = s.review
    const myWin = (i: number) => (me === 'w' ? winPercent(review.evals[i].score) : 100 - winPercent(review.evals[i].score))
    let lastChance: { best: string; index: number } | null = null

    game.plies.forEach((ply, i) => {
      if (ply.color !== me) return
      const mv = review.moves[i]
      const before = review.evals[i]
      if (!before.bestMove || before.bestMove === ply.uci || !before.pv.length) return
      const opponentErred = i > 0 && review.moves[i - 1].winLoss >= 15 && myWin(i) >= 55
      const punish = opponentErred && mv.winLoss >= 7
      const better = (mv.label === 'mistake' || mv.label === 'blunder') && myWin(i) >= 15
      if (!punish && !better) return

      const rawTheme = classifyTactic(ply.fenBefore, before.pv, opp, before.score)
      const rawAllowed = punish ? null : classifyTactic(ply.fenAfter, review.evals[i + 1].pv, me, review.evals[i + 1].score, ply.fenBefore)
      const theme = rawTheme && rawTheme.motif !== 'combination' ? rawTheme : null
      const allowed = rawAllowed && rawAllowed.motif !== 'combination' ? rawAllowed : null
      const bestSan = uciToSan(ply.fenBefore, before.bestMove) ?? before.bestMove
      // "Find a better move" only when there's something concrete to find: a blunder, a named tactic either
      // way, or a forcing answer. Quiet positional improvements make poor puzzles.
      const forcing = /[x+#]/.test(bestSan)
      if (!punish && !(mv.label === 'blunder' || allowed || theme || forcing)) return
      // The same chance missed move after move (e.g. a fork available three turns running) is one puzzle.
      const repeat = lastChance?.best === before.bestMove && lastChance.index === i - 2
      lastChance = { best: before.bestMove, index: i }
      if (repeat) return
      out.push({
        id: `${s.key}:${i + 1}`,
        gameKey: s.key,
        ply: i + 1,
        fen: ply.fenBefore,
        color: me,
        kind: punish ? 'punish' : 'better',
        best: before.bestMove,
        bestSan,
        line: before.pv,
        score: before.score,
        playedSan: ply.san,
        theme,
        allowed,
        title: `${moveName(game, i).replace(/ .*/, '')} vs ${me === 'w' ? s.black : s.white}`,
        date: s.date,
      })
    })
  }
  return out
}

/** The task shown above the board. */
export function puzzlePrompt(p: Puzzle): string {
  return p.kind === 'punish'
    ? `Your opponent just made a mistake. Find the move that punishes it.`
    : `You went wrong here in the game. Find a better move.`
}

/** Hint text for level 1 (level 2 highlights the piece, level 3 shows the move). */
export function puzzleHint(p: Puzzle): string {
  if (p.theme) return `Look for a ${describeTactic({ motif: p.theme.motif, piece: p.theme.piece })}.`
  if (p.allowed) return `In the game, ${p.playedSan} allowed a ${describeTactic({ motif: p.allowed.motif, piece: p.allowed.piece })}. Look for a safer move.`
  return 'Check every capture, check and threat for both sides first.'
}

/** Tactical puzzles first: punishing a blunder, then ones with a named tactic. */
const priority = (p: Puzzle) => (p.kind === 'punish' ? 2 : 0) + (p.theme || p.allowed ? 1 : 0)

/** Next puzzle: due ones first (oldest due first), then new ones, most instructive and most recent first. */
export function nextPuzzle(puzzles: Puzzle[], progress: Map<string, PuzzleProgress>, skip: Set<string>, now = Date.now()) {
  const due = puzzles
    .filter((p) => !skip.has(p.id) && progress.has(p.id) && progress.get(p.id)!.due <= now)
    .sort((a, b) => progress.get(a.id)!.due - progress.get(b.id)!.due)
  if (due.length) return due[0]
  return (
    puzzles
      .filter((p) => !skip.has(p.id) && !progress.has(p.id))
      .sort((a, b) => priority(b) - priority(a) || b.date - a.date || a.ply - b.ply)[0] ?? null
  )
}

/** Update spaced-repetition state after an attempt. */
export function schedule(prev: PuzzleProgress | undefined, id: string, correct: boolean, now = Date.now()): PuzzleProgress {
  const box = correct ? Math.min((prev?.box ?? -1) + 1, INTERVAL_DAYS.length - 1) : 0
  return {
    id,
    box,
    due: correct ? now + INTERVAL_DAYS[box] * 86_400_000 : now + RETRY_MS,
    attempts: (prev?.attempts ?? 0) + 1,
    solves: (prev?.solves ?? 0) + (correct ? 1 : 0),
    lastSeen: now,
  }
}

/** Win% for the side to move in a position, from a White-view score. */
export function moverWin(score: Score, color: 'w' | 'b') {
  return color === 'w' ? winPercent(score) : 100 - winPercent(score)
}
