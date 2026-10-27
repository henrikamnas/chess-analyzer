// Plain-language explanations of individual moves and of the whole game, derived from the review.
// All text goes through t() (i18n.ts), so it follows the selected language.
import { Chess, type PieceSymbol, type Square } from 'chess.js'
import { aggregateAccuracy, formatScore, pvToSan, winPercent, type Game, type GameMeta, type Label, type MoveReview, type Ply, type PositionEval, type Review } from './analysis'
import type { Score } from './engine'
import { sideInText, t } from './i18n'
import type { BookInfo } from './openings'
import { classifyTactic, describeTactic, moveEffects, pieceA, pieceThe, type Tactic } from './tactics'

const VALUE: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 }

/** Material balance in pawns, White minus Black. */
export function material(chess: Chess) {
  let sum = 0
  for (const row of chess.board()) for (const sq of row) if (sq) sum += (sq.color === 'w' ? 1 : -1) * VALUE[sq.type]
  return sum
}

/** Plays a UCI line and returns the material balance at its end. */
export function materialAfter(fen: string, line: string[], maxPlies: number) {
  const chess = new Chess(fen)
  for (const uci of line.slice(0, maxPlies)) {
    try {
      chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] })
    } catch {
      break
    }
  }
  return material(chess)
}

export function materialWords(n: number) {
  if (n >= 8) return t("a queen's worth of material")
  if (n >= 5) return t('a rook')
  if (n === 4) return t('a piece and a pawn')
  if (n === 3) return t('a piece')
  if (n === 2) return t("two pawns' worth of material")
  return t('a pawn')
}

/**
 * The trade along a line, as the side that comes out ahead sees it: "a queen for a bishop", "a rook and a pawn".
 * Null when it doesn't add up to `net` pawns or is too messy to say in a few words (promotions, several pieces
 * of a kind); materialWords is the fallback.
 */
export function tradeWords(fen: string, line: string[], maxPlies: number, gainer: 'w' | 'b', net: number): string | null {
  const chess = new Chess(fen)
  const taken: Record<'w' | 'b', PieceSymbol[]> = { w: [], b: [] } // pieces captured by each side
  for (const uci of line.slice(0, maxPlies)) {
    let m
    try {
      m = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] })
    } catch {
      break
    }
    if (m.promotion) return null
    if (m.captured) taken[m.color].push(m.captured)
  }
  // Pieces of the same worth taken by both sides cancel out (a bishop for a knight is an even trade).
  const gains = [...taken[gainer]]
  const losses: PieceSymbol[] = []
  for (const p of taken[gainer === 'w' ? 'b' : 'w']) {
    const i = gains.findIndex((g) => VALUE[g] === VALUE[p])
    if (i >= 0) gains.splice(i, 1)
    else losses.push(p)
  }
  const worth = (ps: PieceSymbol[]) => ps.reduce((sum, p) => sum + VALUE[p], 0)
  const distinct = (ps: PieceSymbol[]) => new Set(ps).size === ps.length && ps.length <= 2
  if (!gains.length || worth(gains) - worth(losses) !== net || !distinct(gains) || !distinct(losses)) return null
  const list = (ps: PieceSymbol[]) => {
    const names = [...ps].sort((a, b) => VALUE[b] - VALUE[a]).map(pieceA)
    return names.length === 2 ? t('{a} and {b}', { a: names[0], b: names[1] }) : names[0]
  }
  return losses.length ? t('{gains} for {losses}', { gains: list(gains), losses: list(losses) }) : list(gains)
}

/** "12. Nf3" / "12... Nf6" */
/** "12." for a white move, "12..." for a black one */
export function moveNumber(p: Pick<Ply, 'fenBefore' | 'color'>) {
  return `${p.fenBefore.split(' ')[5]}${p.color === 'w' ? '.' : '...'}`
}

export function moveName(game: Game, i: number) {
  const p = game.plies[i]
  return `${moveNumber(p)} ${p.san}`
}

/** UCI line -> "19. Nd5 Qd8 20. Nxf6+" */
export function formatLine(fen: string, line: string[], max = 10) {
  const sans = pvToSan(fen, line, max)
  const [, turn, , , , full] = fen.split(' ')
  let n = Number(full)
  return sans
    .map((san, i) => {
      const white = (turn === 'w') === (i % 2 === 0)
      if (white) return `${n}. ${san}`
      const s = i === 0 ? `${n}... ${san}` : san
      n++
      return s
    })
    .join(' ')
}

function evalWords(score: Score) {
  if (score.mate !== undefined) return t('winning for {side}', { side: sideInText(score.mate > 0 ? 'w' : 'b') })
  const cp = score.cp
  const side = sideInText(cp > 0 ? 'w' : 'b')
  const a = Math.abs(cp)
  if (a < 50) return t('about equal')
  if (a < 150) return t('slightly better for {side}', { side })
  if (a < 400) return t('clearly better for {side}', { side })
  return t('winning for {side}', { side })
}

/** The side an evaluation favours, or null when it's about equal (the same bands as evalWords). */
function favoured(score: Score): 'w' | 'b' | null {
  if (score.mate !== undefined) return score.mate > 0 ? 'w' : 'b'
  return Math.abs(score.cp) < 50 ? null : score.cp > 0 ? 'w' : 'b'
}

/**
 * How the evaluation changed with a move that made things worse for its mover, for when it stays in the same
 * band ("clearly better for White" before and after), where "goes from X to X" would say nothing.
 */
function sameBandShift(mover: 'w' | 'b', score: Score, swing: string) {
  const side = favoured(score)
  if (!side) return t('The position stays about equal, but {side} loses some ground {swing}.', { side: sideInText(mover), swing })
  if (side === mover) return t("{side}'s advantage shrinks {swing}.", { side: sideInText(side), swing })
  return t("{side}'s advantage grows {swing}.", { side: sideInText(side), swing })
}

/** Move label with article: "a mistake" / "ett misstag". */
export function labelWithArticle(label: Label) {
  return t({ best: 'a best move', excellent: 'an excellent move', good: 'a good move', inaccuracy: 'an inaccuracy', mistake: 'a mistake', blunder: 'a blunder' }[label])
}

export interface MoveExplanation {
  /** Why the played move was a mistake (shown with the opponent's punishing line). */
  text: string
  /** What the better move achieves (shown with the engine's preferred line). */
  bestText: string
  /** The opponent's best reply line after this move, starting from the position after it. */
  refutation: string[]
  /** The engine's preferred line instead of this move, starting from the position before it. */
  best: string[]
}

export function explainMove(game: Game, review: Review, i: number): MoveExplanation | null {
  return explainPlayed(game.meta, game.plies[i], review.moves[i], review.evals[i], review.evals[i + 1])
}

/** Explains one judged move from the evaluations before and after it (game moves and side-line moves alike). */
export function explainPlayed(meta: GameMeta, ply: Ply, rv: MoveReview, before: PositionEval, after: PositionEval): MoveExplanation | null {
  if (!['inaccuracy', 'mistake', 'blunder'].includes(rv.label)) return null

  const s = ply.color === 'w' ? 1 : -1
  const mover = ply.color === 'w' ? meta.white : meta.black
  const opponent = ply.color === 'w' ? meta.black : meta.white
  const refutation = after.pv
  const best = before.pv
  // Judge material over the same stretch of moves the text shows, so the claim matches the line.
  const HORIZON = 6
  const refLine = refutation.length ? formatLine(ply.fenAfter, refutation, HORIZON) : ''
  const bestLine = best.length ? formatLine(ply.fenBefore, best, HORIZON) : ''
  const swing = `(${formatScore(before.score)} → ${formatScore(after.score)})`
  const sameBand = evalWords(before.score) === evalWords(after.score)
  const move = rv.bestSan ?? t('another move')

  const afterMate = after.score.mate !== undefined ? after.score.mate * s : undefined
  const beforeMate = before.score.mate !== undefined ? before.score.mate * s : undefined
  const start = s * material(new Chess(ply.fenBefore))
  const viaRefutation = s * materialAfter(ply.fenAfter, refutation, HORIZON)
  const viaBest = s * materialAfter(ply.fenBefore, best, HORIZON)
  const lost = Math.round(start - viaRefutation)
  const missed = Math.round(viaBest - start)
  const diff = Math.round(viaBest - viaRefutation)
  const losesMaterial = lost >= 1 && diff >= 1
  const missesMaterial = missed >= 1 && diff >= 1
  const opp = ply.color === 'w' ? 'b' : 'w'
  // Name the actual trade where we can ("a queen for a bishop"), not just its worth ("a rook").
  const lostWords =
    (lost >= diff ? tradeWords(ply.fenBefore, [ply.uci, ...refutation], HORIZON + 1, opp, lost) : null) ?? materialWords(Math.max(lost, diff))
  const missedWords = tradeWords(ply.fenBefore, best, HORIZON, ply.color, missed) ?? materialWords(missed)

  // The tactic the opponent gets after this move, and the one the mover could have played instead.
  // 'combination' only means "wins material somehow", which the material sentences already say.
  const named = (tc: Tactic | null) => (tc && tc.motif !== 'combination' ? tc : null)
  const allowed = refutation.length ? named(classifyTactic(ply.fenAfter, refutation, ply.color, after.score, ply.fenBefore)) : null
  const missedTactic = best.length ? named(classifyTactic(ply.fenBefore, best, opp, before.score)) : null
  const unguarded = refutation.length ? leftUndefended(ply, refutation[0]) : null
  const bestDoes = best.length ? moveEffects(ply.fenBefore, best[0]) : null
  const replyDoes = refutation.length ? moveEffects(ply.fenAfter, refutation[0]) : null

  // Why the played move is bad
  let text: string
  if (afterMate !== undefined && afterMate < 0) {
    text =
      allowed?.motif === 'back-rank'
        ? t('This allows a back-rank mate in {n}: {line}.', { n: Math.abs(Math.round(afterMate)), line: refLine })
        : t('This allows {opponent} to force mate in {n}: {line}.', { opponent, n: Math.abs(Math.round(afterMate)), line: refLine })
  } else if (beforeMate !== undefined && beforeMate > 0 && (afterMate === undefined || afterMate <= 0)) {
    text = t('{mover} had a forced mate in {n} starting with {move}: {line}.', { mover, n: Math.round(beforeMate), move, line: bestLine })
  } else if (losesMaterial) {
    // Say how the material goes: a piece left without its defender, a tactic, or a piece left en prise.
    const how = unguarded
      ? t('This leaves {piece} on {square} undefended', { piece: pieceThe(unguarded.type), square: unguarded.square })
      : allowed?.motif === 'hanging' && allowed.target && allowed.square
        ? t('This leaves {piece} on {square} open to capture', { piece: pieceThe(allowed.target), square: allowed.square })
        : allowed
          ? t('This allows {tactic}', { tactic: describeTactic(allowed) })
          : null
    text = how
      ? t('{how}, and {opponent} wins {material} {swing}: {line}.', { how, opponent, material: lostWords, swing, line: refLine })
      : replyDoes
        ? t('This loses {material} {swing}. {opponent} answers {move}, which {does}: {line}.', {
            material: lostWords,
            swing,
            opponent,
            move: replyDoes.san,
            does: replyDoes.does,
            line: refLine,
          })
        : t('This loses {material} {swing}. {opponent} answers {line}.', { material: lostWords, swing, opponent, line: refLine })
  } else if (missesMaterial) {
    text =
      missedTactic && missedTactic.motif !== 'hanging'
        ? t('This misses {tactic} with {move}, winning {material} {swing}: {line}.', {
            tactic: describeTactic(missedTactic),
            move,
            material: missedWords,
            swing,
            line: bestLine,
          })
        : t('This misses a chance to win {material} with {move} {swing}: {line}.', { material: missedWords, move, swing, line: bestLine })
  } else {
    // No material at stake within the line: say how the evaluation moved, and what the better move does.
    const shift = sameBand
      ? sameBandShift(ply.color, before.score, swing)
      : t('The position goes from {from} to {to} {swing}.', { from: evalWords(before.score), to: evalWords(after.score), swing })
    const stronger = bestDoes
      ? t('{move} was stronger, as it {does}: {line}.', { move, does: bestDoes.does, line: bestLine })
      : t('{move} was stronger: {line}.', { move, line: bestLine })
    text = `${shift} ${stronger}`
  }

  // What the better move achieves instead, from the mover's point of view
  const moverWin = ply.color === 'w' ? winPercent(before.score) : 100 - winPercent(before.score)
  const outcome = sameBand
    ? t('{before} ({beforeScore} instead of {afterScore} after {played})', {
        before: evalWords(before.score),
        beforeScore: formatScore(before.score),
        afterScore: formatScore(after.score),
        played: ply.san,
      })
    : t('{before} ({beforeScore}) instead of {after} ({afterScore}) after {played}', {
        before: evalWords(before.score),
        beforeScore: formatScore(before.score),
        after: evalWords(after.score),
        afterScore: formatScore(after.score),
        played: ply.san,
      })
  const keeps = moverWin >= 45 ? t('keeps the position {outcome}', { outcome }) : t('limits the damage: {outcome}', { outcome })
  let bestNote: string
  if (beforeMate !== undefined && beforeMate > 0) {
    bestNote = t('{move} forces mate in {n}: {line}.', { move, n: Math.round(beforeMate), line: bestLine })
  } else if (missesMaterial) {
    bestNote = t('{move} wins {material} and {keeps}: {line}.', { move, material: missedWords, keeps, line: bestLine })
    if (bestDoes) bestNote = `${bestDoes.san} ${bestDoes.does}. ${bestNote}`
  } else if (losesMaterial) {
    const saves = missed <= -1 ? t('gives up less material') : t('avoids losing material')
    bestNote = t('{move} {saves} and {keeps}: {line}.', { move, saves, keeps, line: bestLine })
  } else {
    bestNote = t('{move} {keeps}: {line}.', { move, keeps, line: bestLine })
  }

  return { text, bestText: bestNote, refutation, best }
}

/**
 * The mover's piece that the reply captures, if it was defended before the move and isn't any more:
 * the move took away its defender (or was the defender).
 */
function leftUndefended(ply: Ply, reply: string): { type: PieceSymbol; square: Square } | null {
  const square = reply.slice(2, 4) as Square
  const now = new Chess(ply.fenAfter)
  const victim = now.get(square)
  if (!victim || victim.color !== ply.color) return null
  // The piece must have stood there before the move too (otherwise it just moved to an unsafe square).
  const was = new Chess(ply.fenBefore)
  if (was.get(square)?.type !== victim.type) return null
  const defendedBefore = was.attackers(square, ply.color).length > 0
  const defendedNow = now.attackers(square, ply.color).length > 0
  return defendedBefore && !defendedNow ? { type: victim.type, square } : null
}

/**
 * A short note for a good or best move when there's something concrete to say: it starts a forced mate, it is
 * a tactic, or it punishes the opponent's mistake. Null for ordinary moves (nothing worth a sentence).
 */
export function explainGood(
  meta: GameMeta,
  ply: Ply,
  rv: MoveReview,
  before: PositionEval,
  after: PositionEval,
  prev?: { uci: string; rv?: MoveReview }, // the opponent's move just before (its verdict if judged)
): string | null {
  if (rv.label !== 'best' && rv.label !== 'excellent' && rv.label !== 'good') return null
  const s = ply.color === 'w' ? 1 : -1
  const opp = ply.color === 'w' ? 'b' : 'w'
  const opponent = ply.color === 'w' ? meta.black : meta.white
  const mate = after.score.mate !== undefined ? after.score.mate * s : undefined
  const hadMate = before.score.mate !== undefined && before.score.mate * s > 0
  const parts: string[] = []
  if (mate !== undefined && mate >= 1) {
    // Only where the mate starts; the moves after it just carry it out.
    if (!hadMate) parts.push(t('{move} starts a forced mate in {n}.', { move: ply.san, n: Math.round(mate) }))
  } else {
    // Castling isn't a tactic of its own (the rook's new attacks would read as a discovered attack).
    const tc = ply.san.startsWith('O-O') ? null : classifyTactic(ply.fenBefore, [ply.uci, ...after.pv], opp, after.score)
    const to = ply.uci.slice(2, 4) as Square
    const recapture = prev?.uci.slice(2, 4) === to // taking back on the square just captured on
    if (tc?.motif === 'hanging') {
      // "Free" only when nothing guarded it (a defended piece worth more than the capturer still wins material).
      const guarded = new Chess(ply.fenBefore).attackers(to, opp).length > 0
      if (!recapture && !guarded) parts.push(t('{move} takes {tactic}.', { move: ply.san, tactic: describeTactic(tc) }))
    } else if (tc && tc.motif !== 'combination' && tc.motif !== 'mate') parts.push(t('{move} is {tactic}.', { move: ply.san, tactic: describeTactic(tc) }))
  }
  if (rv.label === 'best' && prev && (prev.rv?.label === 'mistake' || prev.rv?.label === 'blunder')) {
    parts.push(t(prev.rv.label === 'blunder' ? "It punishes {opponent}'s blunder." : "It punishes {opponent}'s mistake.", { opponent }))
  }
  return parts.length ? parts.join(' ') : null
}

// --- Whole-game summary ------------------------------------------------------

export type Phase = 'opening' | 'middlegame' | 'endgame'

export function phaseOf(fen: string, plyIndex: number): Phase {
  let pieces = 0
  for (const row of new Chess(fen).board()) for (const sq of row) if (sq && sq.type !== 'p' && sq.type !== 'k') pieces++
  if (pieces <= 6) return 'endgame'
  if (plyIndex < 20 && pieces > 10) return 'opening'
  return 'middlegame'
}

/** Translated phase name ("opening" / "öppning"). */
export const phaseName = (p: Phase) => t(p)
/** Definite form ("the opening" / "öppningen"). */
export const phaseThe = (p: Phase) => t(`the ${p}`)

export interface GameSummary {
  paragraphs: string[]
  phases: { phase: Phase; w: number | null; b: number | null }[]
  moments: { ply: number; label: Label; text: string }[] // ply = 1-based index into the mainline
}

export type AccuracyRating = 'excellent' | 'good' | 'inaccurate' | 'poor'

/** Accuracy band (also used as a CSS class); show it with ratingName(). */
export function rating(acc: number): AccuracyRating {
  if (acc >= 90) return 'excellent'
  if (acc >= 80) return 'good'
  if (acc >= 65) return 'inaccurate'
  return 'poor'
}

export const ratingName = (r: AccuracyRating) => t({ excellent: 'Excellent', good: 'Good', inaccurate: 'Inaccurate', poor: 'Poor' }[r])

export function summarizeGame(game: Game, review: Review, book?: BookInfo | null): GameSummary {
  const { white, black, result } = game.meta
  const opening = game.meta.opening ?? book?.opening?.name
  const name = (c: 'w' | 'b') => (c === 'w' ? white : black)
  const acc = review.accuracy
  const paragraphs: string[] = []

  // Overview
  const winner: 'w' | 'b' | null = result === '1-0' ? 'w' : result === '0-1' ? 'b' : null
  const other = (c: 'w' | 'b') => (c === 'w' ? 'b' : 'w')
  const pct = (c: 'w' | 'b') => `${acc[c].toFixed(0)}%`
  const inOpening = opening ? t(' in the {opening}', { opening }) : ''
  if (winner) {
    const loser = other(winner)
    const verdict =
      acc[winner] >= acc[loser] - 3
        ? t("with {pct} accuracy against {loser}'s {loserPct}", { pct: pct(winner), loser: name(loser), loserPct: pct(loser) })
        : t('despite lower accuracy ({pct} vs {loserPct})', { pct: pct(winner), loserPct: pct(loser) })
    paragraphs.push(t('{winner} won{inOpening} {verdict}.', { winner: name(winner), inOpening, verdict }))
  } else {
    const outcome = result === '*' ? t('The game is unfinished') : t('The game was drawn')
    paragraphs.push(t('{outcome}{inOpening}. Accuracy: {white} {whitePct}, {black} {blackPct}.', { outcome, inOpening, white, whitePct: pct('w'), black, blackPct: pct('b') }))
  }

  // The story: where the game left opening theory, when the winner took control for good, and the biggest swing
  const story: string[] = []
  if (book && book.bookPlies > 0) {
    if (book.bookPlies >= game.plies.length) story.push(t('The whole game followed known opening theory.'))
    else {
      const leaver = game.plies[book.bookPlies].color
      story.push(t('{name} left opening theory with {move}.', { name: name(leaver), move: moveName(game, book.bookPlies) }))
    }
  }
  const wins = review.evals.map((e) => winPercent(e.score))
  if (result === '1-0' || result === '0-1') {
    const winnerIsWhite = result === '1-0'
    let from = -1
    for (let i = wins.length - 1; i >= 0; i--) {
      const w = winnerIsWhite ? wins[i] : 100 - wins[i]
      if (w < 70) break
      from = i
    }
    if (from > 0 && from < wins.length - 1) {
      story.push(t('{name} took a decisive advantage after {move} and never let it go.', { name: winnerIsWhite ? white : black, move: moveName(game, from - 1) }))
    } else if (from === wins.length - 1) {
      story.push(t('The game was decided by the very last move.'))
    } else if (from === -1) {
      story.push(t('The final position was not yet decisive, so the game was likely decided on time.'))
    }
  }

  // Biggest single swing
  let worst = -1
  review.moves.forEach((m, i) => {
    if (worst === -1 || m.winLoss > review.moves[worst].winLoss) worst = i
  })
  if (worst >= 0 && review.moves[worst].winLoss >= 10) {
    const m = review.moves[worst]
    story.push(
      t('The turning point was {move}, {label} that cost {name} about {n}% winning chances.', {
        move: moveName(game, worst),
        label: labelWithArticle(m.label),
        name: name(game.plies[worst].color),
        n: Math.round(m.winLoss),
      }),
    )
  }

  if (story.length) paragraphs.push(story.join(' '))

  // Accuracy by phase
  const byPhase: Record<Phase, { w: number[]; b: number[] }> = {
    opening: { w: [], b: [] },
    middlegame: { w: [], b: [] },
    endgame: { w: [], b: [] },
  }
  game.plies.forEach((p, i) => byPhase[phaseOf(p.fenBefore, i)][p.color].push(review.moves[i].accuracy))
  const phases = (['opening', 'middlegame', 'endgame'] as Phase[])
    .filter((ph) => byPhase[ph].w.length + byPhase[ph].b.length > 0)
    .map((ph) => ({
      phase: ph,
      w: byPhase[ph].w.length ? aggregateAccuracy(byPhase[ph].w) : null,
      b: byPhase[ph].b.length ? aggregateAccuracy(byPhase[ph].b) : null,
    }))

  // Key moments: the worst errors, in game order
  const moments = review.moves
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => m.label === 'blunder' || m.label === 'mistake')
    .sort((a, b) => b.m.winLoss - a.m.winLoss)
    .slice(0, 5)
    .sort((a, b) => a.i - b.i)
    .map(({ m, i }) => ({ ply: i + 1, label: m.label, text: explainMove(game, review, i)?.text ?? '' }))

  return { paragraphs, phases, moments }
}
