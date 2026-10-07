// Practice puzzles made from the player's own reviewed games, with simple spaced repetition.
import { Chess, type Color, type Square } from 'chess.js'
import { formatScore, parseGame, uciToSan, winPercent } from './analysis'
import type { Score } from './engine'
import { explainMove, labelWithArticle, moveName } from './explain'
import { classifyTactic, describeTactic, pieceThe, type Tactic } from './tactics'
import { t } from './i18n'
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
  why: string[] // why the answer works, shown after solving
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
        title: t('{move} vs {opponent}', { move: moveName(game, i).replace(/ .*/, ''), opponent: me === 'w' ? s.black : s.white }),
        date: s.date,
        why: explainAnswer(game, review, i, me === 'w' ? s.black : s.white, punish),
      })
    })
  }
  return out
}

/** The task shown above the board. */
export function puzzlePrompt(p: Puzzle): string {
  return p.kind === 'punish'
    ? t('Your opponent just made a mistake. Find the move that punishes it.')
    : t('You went wrong here in the game. Find a better move.')
}

/** Hint text for level 1 (level 2 highlights the piece, level 3 shows the move). */
export function puzzleHint(p: Puzzle): string {
  if (p.theme) return t('Look for {tactic}.', { tactic: describeTactic({ motif: p.theme.motif, piece: p.theme.piece }) })
  if (p.allowed)
    return t('In the game, {played} allowed {tactic}. Look for a safer move.', {
      played: p.playedSan,
      tactic: describeTactic({ motif: p.allowed.motif, piece: p.allowed.piece }),
    })
  return t('Check every capture, check and threat for both sides first.')
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

const VALUE: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 100 }

/** What a move does on the board: what it takes, whether it checks, and which valuable pieces it newly attacks. */
function moveEffects(fen: string, uci: string): string | null {
  const before = new Chess(fen)
  const me = before.turn()
  const opp: Color = me === 'w' ? 'b' : 'w'
  const after = new Chess(fen)
  let m
  try {
    m = after.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] })
  } catch {
    return null
  }
  const parts: string[] = []
  if (m.captured) parts.push(t('takes {piece} on {square}', { piece: pieceThe(m.captured), square: m.to }))
  if (after.isCheckmate()) parts.push(t('gives checkmate'))
  else if (after.inCheck()) parts.push(t('gives check'))
  // Pieces attacked by the moved piece that weren't attacked by it before: the threat that comes with the move
  const targets: string[] = []
  for (const row of after.board())
    for (const p of row) {
      if (!p || p.color !== opp || p.type === 'k' || p.type === 'p') continue
      const hits = after.attackers(p.square, me).includes(m.to as Square)
      const undefended = after.attackers(p.square, opp).length === 0
      if (hits && (VALUE[p.type] > VALUE[m.piece] || undefended)) targets.push(t('{piece} on {square}', { piece: pieceThe(p.type), square: p.square }))
    }
  if (targets.length) parts.push(t('attacks {targets}', { targets: targets.slice(0, 2).join(t(' and ')) }))
  // Discovered attacks: another of our pieces now hits a valuable target because the moved piece got out of the way
  for (const row of after.board())
    for (const p of row) {
      if (!p || p.color !== opp || p.type === 'p' || targets.some((t) => t.endsWith(p.square))) continue
      const was = new Set(before.attackers(p.square, me))
      const opened = after.attackers(p.square, me).find((sq) => sq !== m.to && !was.has(sq))
      if (opened && p.type !== 'k') {
        parts.push(t('uncovers an attack by {attacker} on {target} on {square}', { attacker: pieceThe(after.get(opened)!.type), target: pieceThe(p.type), square: p.square }))
        break
      }
    }
  if (!parts.length) return null
  const last = parts.pop()!
  return `${m.san} ${parts.length ? `${parts.join(', ')}${t(' and ')}${last}` : last}.`
}

/** Why the puzzle's answer works, in a few sentences built from the stored review. */
function explainAnswer(game: ReturnType<typeof parseGame>, review: StoredGame['review'], i: number, opponent: string, punish: boolean): string[] {
  const ply = game.plies[i]
  const best = review.evals[i].bestMove!
  const out: string[] = []

  if (punish && i > 0) {
    // What the opponent's last move got wrong
    const prev = game.plies[i - 1]
    const err = review.moves[i - 1]
    const was = `${formatScore(review.evals[i - 1].score)} → ${formatScore(review.evals[i].score)}`
    let s = t('{opponent} had just played {move}, {label} ({was})', { opponent, move: prev.san, label: labelWithArticle(err.label), was })
    s += err.bestSan && err.bestSan !== prev.san ? t('; {move} was needed.', { move: err.bestSan }) : '.'
    // Did it leave the square we capture on undefended?
    const target = best.slice(2, 4) as Square
    const victim = new Chess(ply.fenBefore).get(target)
    if (victim && victim.color === prev.color) {
      const defendedBefore = new Chess(prev.fenBefore).attackers(target, prev.color).length > 0
      const defendedNow = new Chess(ply.fenBefore).attackers(target, prev.color).length > 0
      if (defendedBefore && !defendedNow) s += t(' It left {piece} on {square} undefended.', { piece: pieceThe(victim.type), square: target })
    }
    out.push(s)
  }

  const effects = moveEffects(ply.fenBefore, best)
  if (effects) out.push(effects)

  // What it achieves overall, compared with the move played in the game
  const ex = explainMove(game, review, i)
  if (ex) out.push(ex.bestText)
  return out
}
