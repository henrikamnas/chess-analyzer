// Finds recurring mistakes across a player's reviewed games. Only the player's own moves are judged.
import { Chess } from 'chess.js'
import { aggregateAccuracy, parseGame, winPercent, type Game, type Label, type Review } from './analysis'
import { material, materialAfter, moveName, phaseOf, type Phase } from './explain'
import type { StoredGame } from './store'

export interface Example {
  key: string // StoredGame key
  ply: number // 1-based mainline ply to open
  title: string // e.g. "14. Nd5?? vs magnus"
  text: string
}

export interface Insight {
  id: string
  kind: 'problem' | 'strength'
  title: string
  body: string
  weight: number // rough cost in games, for ordering
  examples: Example[]
}

export interface PatternReport {
  user: string
  games: number
  record: { w: number; d: number; l: number }
  accuracy: number
  playedLike: number
  insights: Insight[]
  phases: { phase: Phase; moves: number; errorsPer100: number; accuracy: number }[]
  openings: { name: string; color: 'w' | 'b'; games: number; score: number; accuracy: number }[]
  colors: Record<'w' | 'b', { games: number; score: number; accuracy: number }>
}

const PIECE_NAME: Record<string, string> = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' }
const isError = (l: Label) => l === 'mistake' || l === 'blunder'

/** Clock time left after each ply, in seconds, from [%clk h:mm:ss] comments (Lichess and Chess.com both add them). */
function clocks(pgn: string, plies: number): number[] | null {
  const found = [...pgn.matchAll(/\[%clk\s+(\d+):(\d+):(\d+(?:\.\d+)?)\]/g)].map((m) => +m[1] * 3600 + +m[2] * 60 + +m[3])
  return found.length === plies ? found : null
}

/** Starting time in seconds from the TimeControl header ("600+5"); null for daily games. */
function baseTime(pgn: string): number | null {
  const m = pgn.match(/\[TimeControl "(\d+)(?:\+\d+)?"\]/)
  return m ? Number(m[1]) : null
}

/** "Sicilian Defense: Najdorf Variation" / "Sicilian Defense Najdorf 6.Be3" -> "Sicilian Defense". */
export function openingFamily(name?: string): string {
  if (!name) return 'Unknown opening'
  const words = name.split(':')[0].replace(/\s+\d.*$/, '').split(/\s+/)
  const end = words.findIndex((w) => /^(Game|Defen[cs]e|Opening|Attack|Gambit|System|Countergambit)$/i.test(w))
  return words.slice(0, end >= 0 ? end + 1 : Math.min(2, words.length)).join(' ')
}

function scoreFor(result: string, color: 'w' | 'b') {
  if (result === '1-0') return color === 'w' ? 1 : 0
  if (result === '0-1') return color === 'b' ? 1 : 0
  return 0.5
}

interface GameCtx {
  stored: StoredGame
  game: Game
  review: Review
  me: 'w' | 'b'
  opponent: string
}

const ex = (c: GameCtx, i: number, text: string): Example => ({
  key: c.stored.key,
  ply: i + 1,
  title: `${moveName(c.game, i)}${c.review.moves[i].label === 'blunder' ? '??' : c.review.moves[i].label === 'mistake' ? '?' : ''} vs ${c.opponent}`,
  text,
})

/** Newest examples first, at most `n`. */
const newest = (list: (Example & { date: number })[], n = 6): Example[] =>
  [...list]
    .sort((a, b) => b.date - a.date)
    .slice(0, n)
    .map((e) => ({ key: e.key, ply: e.ply, title: e.title, text: e.text }))

export function buildReport(user: string, stored: StoredGame[]): PatternReport {
  const name = user.toLowerCase()
  const ctxs: GameCtx[] = []
  for (const s of stored) {
    try {
      const me = s.white.toLowerCase() === name ? 'w' : 'b'
      ctxs.push({ stored: s, game: parseGame(s.pgn), review: s.review, me, opponent: me === 'w' ? s.black : s.white })
    } catch {
      /* unparseable game: skip */
    }
  }

  const record = { w: 0, d: 0, l: 0 }
  const accs: number[] = []
  const ratings: number[] = []
  const colors = { w: { games: 0, score: 0, accs: [] as number[] }, b: { games: 0, score: 0, accs: [] as number[] } }
  const phase: Record<Phase, { moves: number; errors: number; accs: number[] }> = {
    opening: { moves: 0, errors: 0, accs: [] },
    middlegame: { moves: 0, errors: 0, accs: [] },
    endgame: { moves: 0, errors: 0, accs: [] },
  }
  const openings = new Map<string, { name: string; color: 'w' | 'b'; games: number; score: number; accs: number[] }>()

  type Ex = Example & { date: number }
  const hung: Ex[] = []
  const hungPieces: Record<string, number> = {}
  const missed: Ex[] = []
  let chances = 0
  let taken = 0
  const missedMates: Ex[] = []
  const allowedMates: Ex[] = []
  const thrown: Ex[] = []
  const lowTimeErrors: Ex[] = []
  let lowTimeMoves = 0
  let normalMoves = 0
  let normalErrors = 0
  let errorsTotal = 0

  for (const c of ctxs) {
    const { game, review, me, stored } = c
    const s = me === 'w' ? 1 : -1
    const score = scoreFor(stored.result, me)
    if (score === 1) record.w++
    else if (score === 0) record.l++
    else record.d++
    accs.push(review.accuracy[me])
    ratings.push(review.rating[me].value)
    colors[me].games++
    colors[me].score += score
    colors[me].accs.push(review.accuracy[me])

    const fam = openingFamily(game.meta.opening)
    const okey = `${fam}|${me}`
    const o = openings.get(okey) ?? { name: fam, color: me, games: 0, score: 0, accs: [] }
    o.games++
    o.score += score
    o.accs.push(review.accuracy[me])
    openings.set(okey, o)

    const clk = clocks(stored.pgn, game.plies.length)
    const base = baseTime(stored.pgn)
    const lowThreshold = base ? Math.max(30, base * 0.1) : null
    const myWin = (i: number) => (me === 'w' ? winPercent(review.evals[i].score) : 100 - winPercent(review.evals[i].score))
    let peak = 0
    let lastHungSquare: string | null = null // the same piece left hanging move after move counts once

    game.plies.forEach((ply, i) => {
      if (ply.color !== me) return
      const mv = review.moves[i]
      const before = review.evals[i]
      const after = review.evals[i + 1]
      const err = isError(mv.label)
      const ph = phaseOf(ply.fenBefore, i)
      phase[ph].moves++
      phase[ph].accs.push(mv.accuracy)
      if (err) {
        phase[ph].errors++
        errorsTotal++
      }

      // Time trouble
      if (clk && lowThreshold !== null) {
        if (clk[i] < lowThreshold) {
          lowTimeMoves++
          if (err) lowTimeErrors.push({ ...ex(c, i, `${Math.round(clk[i])} s left on the clock`), date: stored.date })
        } else {
          normalMoves++
          if (err) normalErrors++
        }
      }

      // Mates
      const beforeMate = before.score.mate !== undefined ? before.score.mate * s : undefined
      const afterMate = after.score.mate !== undefined ? after.score.mate * s : undefined
      // Only short mates count as missed (findable), and only real mistakes from a not-yet-lost position as allowed.
      if (beforeMate !== undefined && beforeMate > 0 && beforeMate <= 3 && !(afterMate !== undefined && afterMate > 0)) {
        missedMates.push({ ...ex(c, i, `Mate in ${Math.round(beforeMate)} with ${mv.bestSan}`), date: stored.date })
      } else if (err && myWin(i) >= 30 && afterMate !== undefined && afterMate < 0) {
        allowedMates.push({ ...ex(c, i, `Allowed mate in ${Math.abs(Math.round(afterMate))}`), date: stored.date })
      }

      // Hanging a piece: a mistake the opponent punishes by simply capturing, winning material at once.
      const reply = after.pv[0]
      if (!err) lastHungSquare = null
      if (err && reply) {
        const board = new Chess(ply.fenAfter)
        const victim = board.get(reply.slice(2, 4) as never)
        if (victim && victim.color === me && victim.type !== 'p') {
          const start = s * material(new Chess(ply.fenBefore))
          const end = s * materialAfter(ply.fenAfter, after.pv, 3)
          const square = reply.slice(2, 4)
          const repeat = square === lastHungSquare
          lastHungSquare = start - end >= 2 ? square : null
          if (start - end >= 2 && !repeat) {
            hungPieces[victim.type] = (hungPieces[victim.type] ?? 0) + 1
            hung.push({ ...ex(c, i, `Your ${PIECE_NAME[victim.type]} on ${reply.slice(2, 4)} was taken`), date: stored.date })
          }
        }
      }

      // Missed chances: the opponent just erred and the best move here would win material.
      const prev = i > 0 ? review.moves[i - 1] : null
      if (prev && (prev.label === 'mistake' || prev.label === 'blunder') && before.pv.length) {
        const gain = s * (materialAfter(ply.fenBefore, before.pv, 4) - material(new Chess(ply.fenBefore)))
        if (gain >= 2) {
          chances++
          if (mv.winLoss < 5) taken++
          else missed.push({ ...ex(c, i, `${mv.bestSan} would have won material`), date: stored.date })
        }
      }

      // Throwing away a won game: track the best position reached, then the move that let it go.
      peak = Math.max(peak, myWin(i))
      if (score < 1 && peak >= 85 && mv.winLoss >= 15 && myWin(i + 1) < 65 && !thrown.some((t) => t.key === stored.key)) {
        thrown.push({ ...ex(c, i, `Was winning (${Math.round(peak)}%), then this`), date: stored.date })
      }
    })
  }

  const n = ctxs.length
  const insights: Insight[] = []
  const pct = (a: number, b: number) => (b ? Math.round((100 * a) / b) : 0)

  if (hung.length >= 2) {
    const top = Object.entries(hungPieces).sort((a, b) => b[1] - a[1])[0]
    insights.push({
      id: 'hanging',
      kind: 'problem',
      title: 'You leave pieces hanging',
      body: `${hung.length} times in ${n} games, a piece was simply captured right after your move, most often your ${PIECE_NAME[top[0]]} (${top[1]}×). Before each move, check what your opponent can take.`,
      weight: hung.length * 0.6,
      examples: newest(hung),
    })
  }
  if (chances >= 3 && chances - taken >= 2) {
    insights.push({
      id: 'missed-chances',
      kind: 'problem',
      title: "You don't punish your opponents' mistakes",
      body: `Your opponents gave away material ${chances} times, and you took it ${taken} times (${pct(taken, chances)}%). After every opponent move, ask: what did that leave undefended?`,
      weight: (chances - taken) * 0.5,
      examples: newest(missed),
    })
  }
  if (lowTimeMoves >= 10 && lowTimeErrors.length >= 2) {
    const lowRate = lowTimeErrors.length / lowTimeMoves
    const normalRate = normalMoves ? normalErrors / normalMoves : 0
    if (lowRate > normalRate * 1.5) {
      insights.push({
        id: 'time',
        kind: 'problem',
        title: 'Time trouble costs you',
        body: `${pct(lowTimeErrors.length, errorsTotal)}% of your mistakes came when you were low on time, where you err ${(lowRate / Math.max(normalRate, 0.001)).toFixed(1)}× as often as usual. Spend less time early so you have some left at the end.`,
        weight: lowTimeErrors.length * 0.5,
        examples: newest(lowTimeErrors),
      })
    }
  }
  if (thrown.length >= 1) {
    insights.push({
      id: 'thrown',
      kind: 'problem',
      title: 'You let winning positions slip',
      body: `In ${thrown.length} game${thrown.length > 1 ? 's' : ''} you had a winning position and didn't win. When you're ahead, slow down: trade pieces and keep everything protected.`,
      weight: thrown.length * 0.8,
      examples: newest(thrown),
    })
  }
  if (missedMates.length >= 1) {
    insights.push({
      id: 'missed-mates',
      kind: 'problem',
      title: 'You miss checkmates',
      body: `You had a forced mate ${missedMates.length} time${missedMates.length > 1 ? 's' : ''} and didn't play it. Always look at checks first: they're the most forcing moves.`,
      weight: missedMates.length * 0.6,
      examples: newest(missedMates),
    })
  }
  if (allowedMates.length >= 2) {
    insights.push({
      id: 'allowed-mates',
      kind: 'problem',
      title: 'You walk into mating attacks',
      body: `${allowedMates.length} times a move of yours allowed a forced mate. Watch your king's escape squares, especially the back rank.`,
      weight: allowedMates.length * 0.6,
      examples: newest(allowedMates),
    })
  }

  const phases = (['opening', 'middlegame', 'endgame'] as Phase[])
    .filter((p) => phase[p].moves > 0)
    .map((p) => ({
      phase: p,
      moves: phase[p].moves,
      errorsPer100: (100 * phase[p].errors) / phase[p].moves,
      accuracy: aggregateAccuracy(phase[p].accs),
    }))
  const comparable = phases.filter((p) => p.moves >= 30)
  if (comparable.length >= 2) {
    const worst = [...comparable].sort((a, b) => b.errorsPer100 - a.errorsPer100)[0]
    const best = [...comparable].sort((a, b) => a.errorsPer100 - b.errorsPer100)[0]
    if (worst.errorsPer100 > best.errorsPer100 * 1.5 && worst.errorsPer100 >= 3) {
      insights.push({
        id: 'phase',
        kind: 'problem',
        title: `Most of your mistakes happen in the ${worst.phase}`,
        body: `You make ${worst.errorsPer100.toFixed(1)} mistakes per 100 moves in the ${worst.phase}, against ${best.errorsPer100.toFixed(1)} in the ${best.phase}.`,
        weight: 0.4,
        examples: [],
      })
    }
    insights.push({
      id: 'strength-phase',
      kind: 'strength',
      title: `Your ${best.phase} is your strongest phase`,
      body: `${best.accuracy.toFixed(0)}% accuracy and only ${best.errorsPer100.toFixed(1)} mistakes per 100 moves.`,
      weight: 0,
      examples: [],
    })
  }

  const openingRows = [...openings.values()]
    .map((o) => ({ name: o.name, color: o.color, games: o.games, score: o.score / o.games, accuracy: aggregateAccuracy(o.accs) }))
    .sort((a, b) => b.games - a.games)
  const weakOpening = openingRows.filter((o) => o.games >= 3 && o.score <= 0.35).sort((a, b) => a.score - b.score)[0]
  if (weakOpening) {
    insights.push({
      id: 'opening',
      kind: 'problem',
      title: `${weakOpening.name} is a weak spot`,
      body: `As ${weakOpening.color === 'w' ? 'White' : 'Black'} you scored ${pct(weakOpening.score * weakOpening.games, weakOpening.games)}% in ${weakOpening.games} games of the ${weakOpening.name}. Worth looking up its main ideas.`,
      weight: weakOpening.games * (0.5 - weakOpening.score),
      examples: [],
    })
  }
  const strongOpening = openingRows.filter((o) => o.games >= 3 && o.score >= 0.65).sort((a, b) => b.score - a.score)[0]
  if (strongOpening) {
    insights.push({
      id: 'strength-opening',
      kind: 'strength',
      title: `You do well in the ${strongOpening.name}`,
      body: `As ${strongOpening.color === 'w' ? 'White' : 'Black'} you scored ${pct(strongOpening.score * strongOpening.games, strongOpening.games)}% in ${strongOpening.games} games.`,
      weight: 0,
      examples: [],
    })
  }

  const col = (c: 'w' | 'b') => ({
    games: colors[c].games,
    score: colors[c].games ? colors[c].score / colors[c].games : 0,
    accuracy: aggregateAccuracy(colors[c].accs),
  })

  insights.sort((a, b) => (a.kind === b.kind ? b.weight - a.weight : a.kind === 'problem' ? -1 : 1))

  return {
    user,
    games: n,
    record,
    accuracy: accs.length ? accs.reduce((a, b) => a + b, 0) / accs.length : 0,
    playedLike: ratings.length ? Math.round(ratings.reduce((a, b) => a + b, 0) / ratings.length / 50) * 50 : 0,
    insights,
    phases,
    openings: openingRows,
    colors: { w: col('w'), b: col('b') },
  }
}
