// Finds recurring mistakes across a player's reviewed games. Only the player's own moves are judged.
import { aggregateAccuracy, parseGame, rateReview, winPercent, type Game, type Label, type Review } from './analysis'
import { moveName, phaseOf, phaseThe, type Phase } from './explain'
import { classifyTactic, describeTactic, pieceA, type Motif, type Tactic } from './tactics'
import { sideInText, t, tn } from './i18n'
import type { StoredGame } from './store'

export interface Example {
  key: string // StoredGame key
  ply: number // 1-based mainline ply to open
  title: string // e.g. "14. Nd5?? vs magnus"
  text: string
}

export interface Insight {
  id: string
  kind: 'problem' | 'strength' | 'trend'
  title: string
  body: string
  evidence: string // what the finding is based on, e.g. "7 times in 30 games"
  tentative: boolean // too little data to be sure
  weight: number // rough cost, for ordering
  examples: Example[]
}

export interface PatternReport {
  user: string
  games: number
  record: { w: number; d: number; l: number }
  accuracy: number
  playedLike: number
  insights: Insight[]
  /** What the opponent did to punish your mistakes, and what you missed when they erred. */
  tactics: { motif: Motif; against: number; missed: number }[]
  phases: { phase: Phase; moves: number; errorsPer100: number; accuracy: number }[]
  openings: { name: string; color: 'w' | 'b'; games: number; score: number; accuracy: number }[]
  colors: Record<'w' | 'b', { games: number; score: number; accuracy: number }>
}

const isError = (l: Label) => l === 'mistake' || l === 'blunder'
const MIN_GAMES_CONFIDENT = 15

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

type Ex = Example & { date: number }

const ex = (c: GameCtx, i: number, text: string): Ex => ({
  key: c.stored.key,
  ply: i + 1,
  title: t('{move} vs {opponent}', {
    move: `${moveName(c.game, i)}${c.review.moves[i].label === 'blunder' ? '??' : c.review.moves[i].label === 'mistake' ? '?' : ''}`,
    opponent: c.opponent,
  }),
  text,
  date: c.stored.date,
})

/** Newest examples first, at most `n`. */
const newest = (list: Ex[], n = 6): Example[] =>
  [...list]
    .sort((a, b) => b.date - a.date)
    .slice(0, n)
    .map((e) => ({ key: e.key, ply: e.ply, title: e.title, text: e.text }))

/** The most common value in a list, with its count. */
function mostCommon<T>(items: T[]): [T, number] | null {
  const counts = new Map<T, number>()
  for (const x of items) counts.set(x, (counts.get(x) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? null
}

export function buildReport(user: string, stored: StoredGame[]): PatternReport {
  const name = user.toLowerCase()
  const ctxs: GameCtx[] = []
  for (const s of stored) {
    try {
      const me = s.white.toLowerCase() === name ? 'w' : 'b'
      const game = parseGame(s.pgn)
      ctxs.push({ stored: s, game, review: rateReview(s.review, game), me, opponent: me === 'w' ? s.black : s.white })
    } catch {
      /* unparseable game: skip */
    }
  }
  const n = ctxs.length

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

  // Tactics used against you (after your mistakes) and missed by you (after your opponent's)
  const against: { tactic: Tactic; ex: Ex }[] = []
  const missedTactics: { tactic: Tactic | null; ex: Ex }[] = []
  let chances = 0
  let taken = 0
  const missedMates: Ex[] = []
  const thrown: Ex[] = []
  const lowTimeErrors: Ex[] = []
  let lowTimeMoves = 0
  let normalMoves = 0
  let normalErrors = 0
  let closeErrors = 0
  const perGame: { date: number; accuracy: number; errors: number }[] = []

  for (const c of ctxs) {
    const { game, review, me, stored } = c
    const opp = me === 'w' ? 'b' : 'w'
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
    let gameErrors = 0

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
    let lastHangingSquare: string | undefined

    game.plies.forEach((ply, i) => {
      if (ply.color !== me) return
      const mv = review.moves[i]
      const before = review.evals[i]
      const after = review.evals[i + 1]
      const err = isError(mv.label)
      if (err) gameErrors++
      // Phase and time statistics only count positions that were still undecided: in won or lost positions
      // even bad moves barely change the win%, which would make e.g. endgames look better than they are.
      const close = myWin(i) >= 10 && myWin(i) <= 90
      if (close) {
        const ph = phaseOf(ply.fenBefore, i)
        phase[ph].moves++
        phase[ph].accs.push(mv.accuracy)
        if (err) {
          phase[ph].errors++
          closeErrors++
        }
        if (clk && lowThreshold !== null) {
          if (clk[i] < lowThreshold) {
            lowTimeMoves++
            if (err) lowTimeErrors.push(ex(c, i, t('{n} s left on the clock', { n: Math.round(clk[i]) })))
          } else {
            normalMoves++
            if (err) normalErrors++
          }
        }
      }

      // What did the opponent's best reply do to you?
      if (err) {
        const tac = classifyTactic(ply.fenAfter, after.pv, me, after.score, ply.fenBefore)
        // The same piece left hanging move after move counts once.
        const repeat = tac?.motif === 'hanging' && tac.square === lastHangingSquare
        lastHangingSquare = tac?.motif === 'hanging' ? tac.square : undefined
        if (tac && !repeat) against.push({ tactic: tac, ex: ex(c, i, t('Allowed {tactic}', { tactic: describeTactic(tac) })) })
      } else {
        lastHangingSquare = undefined
      }

      // Missed chances: the opponent's last move handed you a clearly better position; did you keep it?
      if (i > 0 && review.moves[i - 1].winLoss >= 15 && myWin(i) >= 55) {
        chances++
        if (mv.winLoss < 7) taken++
        else {
          const tac = classifyTactic(ply.fenBefore, before.pv, opp, before.score)
          const how = tac && tac.motif !== 'combination' ? ` (${describeTactic(tac)})` : ''
          missedTactics.push({ tactic: tac, ex: ex(c, i, t('{move} was winning{how}', { move: mv.bestSan ?? '', how })) })
        }
      }

      // Missed short mates
      const beforeMate = before.score.mate !== undefined ? before.score.mate * s : undefined
      const afterMate = after.score.mate !== undefined ? after.score.mate * s : undefined
      if (beforeMate !== undefined && beforeMate > 0 && beforeMate <= 3 && !(afterMate !== undefined && afterMate > 0)) {
        missedMates.push(ex(c, i, t('Mate in {n} with {move}', { n: Math.round(beforeMate), move: mv.bestSan ?? '' })))
      }

      // Throwing away a won game: track the best position reached, then the move that let it go.
      peak = Math.max(peak, myWin(i))
      if (score < 1 && peak >= 85 && mv.winLoss >= 15 && myWin(i + 1) < 65 && !thrown.some((x) => x.key === stored.key)) {
        thrown.push(ex(c, i, t('Was winning ({n}%), then this', { n: Math.round(peak) })))
      }
    })
    perGame.push({ date: stored.date, accuracy: review.accuracy[me], errors: gameErrors })
  }

  const insights: Insight[] = []
  const pct = (a: number, b: number) => (b ? Math.round((100 * a) / b) : 0)
  const times = (k: number) => tn('{n} time', '{n} times', k)
  const evidence = (k: number) => t('{times} in {games} games', { times: times(k), games: n })
  const tentative = (k: number) => n < MIN_GAMES_CONFIDENT || k < 3

  // Tactics used against you, grouped
  const byMotif = (...motifs: Motif[]) => against.filter((a) => motifs.includes(a.tactic.motif))
  const hanging = byMotif('hanging')
  if (hanging.length >= 2) {
    const [piece, k] = mostCommon(hanging.map((h) => h.tactic.target!))!
    insights.push({
      id: 'hanging',
      kind: 'problem',
      title: t('You leave pieces hanging'),
      body: t('A piece of yours was simply taken for free, most often {piece} ({k}×). Before each move, check what your opponent can capture.', { piece: pieceA(piece), k }),
      evidence: evidence(hanging.length),
      tentative: tentative(hanging.length),
      weight: hanging.length * 0.6,
      examples: newest(hanging.map((h) => h.ex)),
    })
  }
  const forks = byMotif('fork')
  if (forks.length >= 2) {
    const [piece] = mostCommon(forks.map((f) => f.tactic.piece!))!
    insights.push({
      id: 'forks',
      kind: 'problem',
      title: t('You walk into forks'),
      body: t('Your opponent attacked two of your pieces at once, mostly with {piece}. Watch for squares where one enemy piece could hit two of yours, especially king and queen.', { piece: pieceA(piece) }),
      evidence: evidence(forks.length),
      tentative: tentative(forks.length),
      weight: forks.length * 0.6,
      examples: newest(forks.map((f) => f.ex)),
    })
  }
  const lines = byMotif('pin', 'skewer')
  if (lines.length >= 2) {
    insights.push({
      id: 'pins',
      kind: 'problem',
      title: t('Pins and skewers cost you material'),
      body: t('Pieces lined up with your king or queen got pinned or skewered by a bishop, rook or queen. Avoid leaving valuable pieces on the same line.'),
      evidence: evidence(lines.length),
      tentative: tentative(lines.length),
      weight: lines.length * 0.6,
      examples: newest(lines.map((l) => l.ex)),
    })
  }
  const disc = byMotif('discovered')
  if (disc.length >= 2) {
    insights.push({
      id: 'discovered',
      kind: 'problem',
      title: t('Discovered attacks catch you out'),
      body: t("An enemy piece moved out of the way and uncovered an attack from the piece behind it. Look at what's lined up behind your opponent's pieces, not just the pieces themselves."),
      evidence: evidence(disc.length),
      tentative: tentative(disc.length),
      weight: disc.length * 0.6,
      examples: newest(disc.map((d) => d.ex)),
    })
  }
  const mates = byMotif('mate', 'back-rank')
  if (mates.length >= 2) {
    const backRank = mates.filter((m) => m.tactic.motif === 'back-rank').length
    insights.push({
      id: 'mates',
      kind: 'problem',
      title: t('You walk into mating attacks'),
      body: backRank
        ? t('A move of yours allowed a forced mate, {n} of them on your back rank (give your king an escape square, e.g. a pawn move like h3).', { n: backRank })
        : t('A move of yours allowed a forced mate.'),
      evidence: evidence(mates.length),
      tentative: tentative(mates.length),
      weight: mates.length * 0.7,
      examples: newest(mates.map((m) => m.ex)),
    })
  }

  if (chances >= 3 && chances - taken >= 2) {
    const named = missedTactics.filter((m) => m.tactic && m.tactic.motif !== 'combination')
    const top = mostCommon(named.map((m) => m.tactic!.motif))
    insights.push({
      id: 'missed-chances',
      kind: 'problem',
      title: t("You don't punish your opponents' mistakes"),
      body:
        t("Your opponent's move gave you a clearly better position {chances}; you kept the advantage {taken} ({pct}%).", {
          chances: times(chances),
          taken: times(taken),
          pct: pct(taken, chances),
        }) +
        (top ? t(' The win you missed was most often {tactic}.', { tactic: describeTactic({ motif: top[0] }) }) : '') +
        t(' After every opponent move, ask what it left undefended.'),
      evidence: t('{missed} missed out of {chances} chances in {games} games', { missed: chances - taken, chances, games: n }),
      tentative: n < MIN_GAMES_CONFIDENT || chances < 5,
      weight: (chances - taken) * 0.5,
      examples: newest(missedTactics.map((m) => m.ex)),
    })
  }
  if (lowTimeMoves >= 10 && lowTimeErrors.length >= 2) {
    const lowRate = lowTimeErrors.length / lowTimeMoves
    const normalRate = normalMoves ? normalErrors / normalMoves : 0
    if (lowRate > normalRate * 1.5) {
      insights.push({
        id: 'time',
        kind: 'problem',
        title: t('Time trouble costs you'),
        body: t('{pct}% of your mistakes came when you were low on time, where you err {x}× as often as usual. Spend less time early so you have some left at the end.', {
          pct: pct(lowTimeErrors.length, closeErrors),
          x: (lowRate / Math.max(normalRate, 0.001)).toFixed(1),
        }),
        evidence: t('{errors} mistakes in {moves} low-time moves', { errors: lowTimeErrors.length, moves: lowTimeMoves }),
        tentative: lowTimeErrors.length < 4,
        weight: lowTimeErrors.length * 0.5,
        examples: newest(lowTimeErrors),
      })
    }
  }
  if (thrown.length >= 1) {
    insights.push({
      id: 'thrown',
      kind: 'problem',
      title: t('You let winning positions slip'),
      body: t("You had a winning position and didn't win. When you're ahead, slow down: trade pieces and keep everything protected."),
      evidence: t('{k} of {games} games', { k: thrown.length, games: n }),
      tentative: tentative(thrown.length),
      weight: thrown.length * 0.8,
      examples: newest(thrown),
    })
  }
  if (missedMates.length >= 1) {
    insights.push({
      id: 'missed-mates',
      kind: 'problem',
      title: t('You miss checkmates'),
      body: t("You had a short forced mate and didn't play it. Always look at checks first: they're the most forcing moves."),
      evidence: evidence(missedMates.length),
      tentative: tentative(missedMates.length),
      weight: missedMates.length * 0.6,
      examples: newest(missedMates),
    })
  }

  // Phases (close positions only)
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
        title: t('Most of your mistakes happen in {phase}', { phase: phaseThe(worst.phase) }),
        body: t('In positions that were still undecided, you make {worst} mistakes per 100 moves in {worstPhase}, against {best} in {bestPhase}.', {
          worst: worst.errorsPer100.toFixed(1),
          worstPhase: phaseThe(worst.phase),
          best: best.errorsPer100.toFixed(1),
          bestPhase: phaseThe(best.phase),
        }),
        evidence: t('{worstMoves} moves in {worstPhase} and {bestMoves} in {bestPhase}', {
          worstMoves: worst.moves,
          worstPhase: phaseThe(worst.phase),
          bestMoves: best.moves,
          bestPhase: phaseThe(best.phase),
        }),
        tentative: worst.moves < 60 || best.moves < 60,
        weight: 0.4,
        examples: [],
      })
    }
    insights.push({
      id: 'strength-phase',
      kind: 'strength',
      title: t('Your strongest phase is {phase}', { phase: phaseThe(best.phase) }),
      body: t('In undecided positions: {acc}% accuracy and {errors} mistakes per 100 moves.', { acc: best.accuracy.toFixed(0), errors: best.errorsPer100.toFixed(1) }),
      evidence: t('{n} moves', { n: best.moves }),
      tentative: best.moves < 60,
      weight: 0,
      examples: [],
    })
  }

  // Openings
  const openingRows = [...openings.values()]
    .map((o) => ({ name: o.name, color: o.color, games: o.games, score: o.score / o.games, accuracy: aggregateAccuracy(o.accs) }))
    .sort((a, b) => b.games - a.games)
  const weakOpening = openingRows.filter((o) => o.games >= 3 && o.score <= 0.35).sort((a, b) => a.score - b.score)[0]
  if (weakOpening) {
    insights.push({
      id: 'opening',
      kind: 'problem',
      title: t('{opening} is a weak spot', { opening: t(weakOpening.name) }),
      body: t('As {color} you scored {pct}% in the {opening}. Worth looking up its main ideas.', {
        color: sideInText(weakOpening.color),
        pct: Math.round(weakOpening.score * 100),
        opening: t(weakOpening.name),
      }),
      evidence: tn('{n} game', '{n} games', weakOpening.games),
      tentative: weakOpening.games < 5,
      weight: weakOpening.games * (0.5 - weakOpening.score),
      examples: [],
    })
  }
  const strongOpening = openingRows.filter((o) => o.games >= 3 && o.score >= 0.65).sort((a, b) => b.score - a.score)[0]
  if (strongOpening) {
    insights.push({
      id: 'strength-opening',
      kind: 'strength',
      title: t('You do well in the {opening}', { opening: t(strongOpening.name) }),
      body: t('As {color} you scored {pct}%.', { color: sideInText(strongOpening.color), pct: Math.round(strongOpening.score * 100) }),
      evidence: tn('{n} game', '{n} games', strongOpening.games),
      tentative: strongOpening.games < 5,
      weight: 0,
      examples: [],
    })
  }

  // Trend: recent half vs older half
  if (perGame.length >= 12) {
    const sorted = [...perGame].sort((a, b) => a.date - b.date)
    const half = Math.floor(sorted.length / 2)
    const older = sorted.slice(0, half)
    const recent = sorted.slice(sorted.length - half)
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
    const accOld = avg(older.map((g) => g.accuracy))
    const accNew = avg(recent.map((g) => g.accuracy))
    const errOld = avg(older.map((g) => g.errors))
    const errNew = avg(recent.map((g) => g.errors))
    const better = accNew - accOld >= 3 || errOld - errNew >= 0.5
    const worse = accOld - accNew >= 3 || errNew - errOld >= 0.5
    insights.push({
      id: 'trend',
      kind: 'trend',
      title: t(better && !worse ? "You're improving" : worse && !better ? 'Your recent games were weaker' : 'Your level is steady'),
      body: t('Your last {half} games: {accNew}% accuracy and {errNew} mistakes per game, against {accOld}% and {errOld} in the {half} before.', {
        half,
        accNew: accNew.toFixed(0),
        errNew: errNew.toFixed(1),
        accOld: accOld.toFixed(0),
        errOld: errOld.toFixed(1),
      }),
      evidence: tn('{n} game', '{n} games', half * 2),
      tentative: half < 10,
      weight: 0,
      examples: [],
    })
  }

  const col = (c: 'w' | 'b') => ({
    games: colors[c].games,
    score: colors[c].games ? colors[c].score / colors[c].games : 0,
    accuracy: aggregateAccuracy(colors[c].accs),
  })

  const motifs: Motif[] = ['hanging', 'fork', 'pin', 'skewer', 'discovered', 'back-rank', 'mate', 'combination']
  const tactics = motifs
    .map((motif) => ({
      motif,
      against: against.filter((a) => a.tactic.motif === motif).length,
      missed: missedTactics.filter((m) => m.tactic?.motif === motif).length,
    }))
    .filter((t) => t.against || t.missed)

  const order = { problem: 0, trend: 1, strength: 2 }
  insights.sort((a, b) => order[a.kind] - order[b.kind] || b.weight - a.weight)

  return {
    user,
    games: n,
    record,
    accuracy: accs.length ? accs.reduce((a, b) => a + b, 0) / accs.length : 0,
    playedLike: ratings.length ? Math.round(ratings.reduce((a, b) => a + b, 0) / ratings.length / 50) * 50 : 0,
    insights,
    tactics,
    phases,
    openings: openingRows,
    colors: { w: col('w'), b: col('b') },
  }
}
