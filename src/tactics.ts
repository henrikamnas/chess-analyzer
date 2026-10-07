// Names the tactic in an engine line: what the first move of `line` (played from `fen`) does to `victim`.
// Used both for mistakes ("you got forked") and for missed chances ("you could have forked").
import { Chess, type Color, type PieceSymbol, type Square } from 'chess.js'
import type { Score } from './engine'
import { t } from './i18n'

export type Motif = 'mate' | 'back-rank' | 'hanging' | 'fork' | 'pin' | 'skewer' | 'discovered' | 'combination'

export interface Tactic {
  motif: Motif
  piece?: PieceSymbol // the piece that does it (forks, pins…)
  target?: PieceSymbol // the main piece that is won or attacked
  square?: Square
}

const VALUE: Record<PieceSymbol, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 100 }
const FILES = 'abcdefgh'

const MOTIF_EN: Record<Motif, string> = {
  mate: 'mating attack',
  'back-rank': 'back-rank mate',
  hanging: 'free piece',
  fork: 'fork',
  pin: 'pin',
  skewer: 'skewer',
  discovered: 'discovered attack',
  combination: 'combination',
}
const PIECE_EN: Record<PieceSymbol, string> = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' }

/** Name of a tactic type, e.g. "fork" / "gaffel". */
export const motifName = (m: Motif) => t(MOTIF_EN[m])
/** Piece name: "knight" / "springare". */
export const pieceName = (p: PieceSymbol) => t(PIECE_EN[p])
/** Definite form: "the knight" / "springaren". */
export const pieceThe = (p: PieceSymbol) => t(`the ${PIECE_EN[p]}`)
/** With indefinite article: "a knight" / "en springare", "a rook" / "ett torn". */
export const pieceA = (p: PieceSymbol) => t(`a ${PIECE_EN[p]}`)

const sq = (f: number, r: number) => `${FILES[f]}${r + 1}` as Square
const coords = (s: Square): [number, number] => [FILES.indexOf(s[0]), Number(s[1]) - 1]

function play(chess: Chess, uci: string) {
  try {
    return chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] })
  } catch {
    return null
  }
}

function materialFor(chess: Chess, color: Color) {
  let sum = 0
  for (const row of chess.board())
    for (const p of row) if (p && p.type !== 'k') sum += (p.color === color ? 1 : -1) * VALUE[p.type]
  return sum
}

/** Squares of `color`'s pieces that are kings or worth at least a minor piece. */
function valuables(chess: Chess, color: Color) {
  const out: { square: Square; type: PieceSymbol }[] = []
  for (const row of chess.board()) for (const p of row) if (p && p.color === color && p.type !== 'p') out.push({ square: p.square, type: p.type })
  return out
}

/** First two pieces met along a ray from `from` (exclusive). */
function along(chess: Chess, from: Square, df: number, dr: number) {
  const found: { square: Square; color: Color; type: PieceSymbol }[] = []
  let [f, r] = coords(from)
  for (;;) {
    f += df
    r += dr
    if (f < 0 || f > 7 || r < 0 || r > 7) return found
    const p = chess.get(sq(f, r))
    if (p) {
      found.push({ square: sq(f, r), color: p.color, type: p.type })
      if (found.length === 2) return found
    }
  }
}

const RAYS: Record<string, [number, number][]> = {
  b: [[1, 1], [1, -1], [-1, 1], [-1, -1]],
  r: [[1, 0], [-1, 0], [0, 1], [0, -1]],
  q: [[1, 1], [1, -1], [-1, 1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1]],
}

/**
 * Classify the tactic in `line` against `victim`. `endScore` is the engine score after the line's first move,
 * from White's point of view, used to recognise forced mates. `baselineFen` is where material is counted from:
 * pass the position before the victim's own move, so a recapture after a trade isn't mistaken for a won piece.
 * Returns null for quiet/positional lines.
 */
export function classifyTactic(fen: string, line: string[], victim: Color, endScore?: Score, baselineFen = fen): Tactic | null {
  if (!line.length) return null
  const attacker: Color = victim === 'w' ? 'b' : 'w'
  const before = new Chess(fen)
  if (before.turn() !== attacker) return null

  // Forced mate against the victim
  if (endScore?.mate !== undefined && (victim === 'w' ? endScore.mate < 0 : endScore.mate > 0)) {
    const replay = new Chess(fen)
    let last = null
    for (const uci of line) {
      last = play(replay, uci)
      if (!last || replay.isCheckmate()) break
    }
    if (last && replay.isCheckmate()) {
      const king = valuables(replay, victim).find((p) => p.type === 'k')
      const backRank = victim === 'w' ? '1' : '8'
      if (king?.square[1] === backRank && last.to[1] === backRank && (last.piece === 'r' || last.piece === 'q')) {
        return { motif: 'back-rank', piece: last.piece, square: last.to }
      }
    }
    return { motif: 'mate' }
  }

  const after = new Chess(fen)
  const move = play(after, line[0])
  if (!move) return null
  const moved = move.piece
  const to = move.to

  // Over the next few moves, does the victim actually lose material? Tactics that don't win anything don't count.
  const start = materialFor(new Chess(baselineFen), attacker)
  const replay = new Chess(fen)
  for (const uci of line.slice(0, 5)) if (!play(replay, uci)) break
  const gain = materialFor(replay, attacker) - start
  const wins = gain >= 2

  // Free piece: a direct capture of a piece that was undefended, or defended but worth more than the capturer
  if (move.captured && move.captured !== 'p') {
    const defended = before.attackers(to, victim).length > 0
    if (!defended || VALUE[move.captured] > VALUE[moved]) {
      return wins ? { motif: 'hanging', piece: moved, target: move.captured, square: to } : null
    }
  }
  if (!wins) return null

  // Fork: the moved piece, standing safely, now attacks two or more valuable targets (the king counts).
  // "Safely": no legal capture of it (pinned pieces and check are respected), or only by pieces worth more
  // than it while it is defended.
  const capturers = after.moves({ verbose: true }).filter((m) => m.to === to && m.captured)
  const defended = after.attackers(to, attacker).length > 0
  const safe = capturers.length === 0 || (defended && capturers.every((m) => VALUE[m.piece] > VALUE[moved]))
  const targets = !safe ? [] : valuables(after, victim).filter(
    (p) => after.attackers(p.square, attacker).includes(to) && (p.type === 'k' || VALUE[p.type] >= VALUE[moved] || !after.attackers(p.square, victim).length),
  )
  if (targets.length >= 2) {
    const main = targets.filter((t) => t.type !== 'k').sort((a, b) => VALUE[b.type] - VALUE[a.type])[0]
    return { motif: 'fork', piece: moved, target: main?.type, square: to }
  }

  // Pin / skewer along the moved piece's lines
  for (const [df, dr] of RAYS[moved] ?? []) {
    const [first, second] = along(after, to, df, dr)
    if (!first || !second || first.color !== victim || second.color !== victim) continue
    if (VALUE[second.type] > VALUE[first.type] && VALUE[second.type] >= 5) {
      return { motif: 'pin', piece: moved, target: first.type, square: first.square }
    }
    if (VALUE[first.type] > VALUE[second.type] && VALUE[first.type] >= 5 && VALUE[second.type] >= 3) {
      return { motif: 'skewer', piece: moved, target: second.type, square: second.square }
    }
  }

  // Discovered attack: moving the piece uncovered another piece's attack on a valuable target
  for (const t of valuables(after, victim)) {
    const now = after.attackers(t.square, attacker).filter((s) => s !== to)
    const was = new Set(before.attackers(t.square, attacker))
    const opened = now.find((s) => !was.has(s))
    if (opened) return { motif: 'discovered', piece: after.get(opened)?.type, target: t.type, square: t.square }
  }

  return { motif: 'combination', piece: moved }
}

/**
 * Short description with its article, e.g. "a knight fork on e7" / "en springargaffel på e7",
 * "a free bishop on d3", "a back-rank mate". Articles are part of the phrase because their
 * form depends on the noun in Swedish (en gaffel, ett spett).
 */
export function describeTactic(tc: Tactic): string {
  const on = (text: string) => (tc.square ? t('{what} on {square}', { what: text, square: tc.square }) : text)
  switch (tc.motif) {
    case 'hanging':
      return on(t(`a free ${tc.target ? PIECE_EN[tc.target] : 'piece'}`))
    case 'fork':
      return on(t(tc.piece ? `a ${PIECE_EN[tc.piece]} fork` : 'a fork'))
    case 'pin':
    case 'skewer': {
      if (!tc.piece || !tc.target) return t(`a ${tc.motif}`)
      return t(`a {piece} ${tc.motif} of {target}`, { piece: pieceName(tc.piece), pieceThe: pieceThe(tc.piece), target: pieceThe(tc.target) })
    }
    case 'discovered':
      return tc.target ? t('a discovered attack on {target}', { target: pieceThe(tc.target) }) : t('a discovered attack')
    default:
      return t(`a ${MOTIF_EN[tc.motif]}`)
  }
}
