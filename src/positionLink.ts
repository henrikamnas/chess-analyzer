// Links that open a position with a line of moves on the board, e.g. from an AI chat:
//   …/#fen=<FEN with _ for spaces>&pre=<moves>&line=<moves>
// `pre` is a side line already on the board when the link was made; `line` is what the AI appends.
// Moves are SAN separated by commas. The hash is parsed by hand: "+" and "#" are meaningful in SAN.
import { Chess } from 'chess.js'

export interface PositionLink {
  fen: string
  moves: string[] // SAN: `pre` then `line`
}

/** The link for a position, ready for moves to be appended after "line=". `pre`: SAN moves from `fen`. */
export function positionLinkBase(fen: string, pre: string[] = []): string {
  const base = `${location.origin}${location.pathname}`
  return `${base}#fen=${fen.replace(/ /g, '_')}${pre.length ? `&pre=${pre.join(',')}` : ''}&line=`
}

/** Reads a position link from the address bar and removes it, so a reload doesn't apply it again. */
export function takePositionLink(): PositionLink | null {
  const hash = location.hash.slice(1)
  if (!hash.startsWith('fen=')) return null
  history.replaceState(null, '', location.pathname + location.search)
  const params = new Map<string, string>()
  for (const part of hash.split('&')) {
    const i = part.indexOf('=')
    if (i > 0) params.set(part.slice(0, i), safeDecode(part.slice(i + 1)))
  }
  const fen = (params.get('fen') ?? '').replace(/_/g, ' ').trim()
  try {
    new Chess(fen)
  } catch {
    return null
  }
  const moves = [params.get('pre') ?? '', params.get('line') ?? ''].flatMap(splitMoves)
  return { fen, moves }
}

function safeDecode(s: string) {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/** "10. Nxb5 cxb5, 11.Bxb5+!" -> ["Nxb5", "cxb5", "Bxb5+"]: drops move numbers and annotation marks. */
function splitMoves(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((m) => m.replace(/^\d+\.+/, '').replace(/[!?]+$/, ''))
    .filter((m) => m && !/^\d+\.*$/.test(m))
}

/** Plays SAN moves from `fen`; returns them as UCI, up to the first move that isn't legal (named in `bad`). */
export function sanToUci(fen: string, sans: string[]): { uci: string[]; bad: string | null } {
  const chess = new Chess(fen)
  const uci: string[] = []
  for (const san of sans) {
    try {
      const m = chess.move(san.replace(/[+#]+$/, ''), { strict: false })
      uci.push(m.from + m.to + (m.promotion ?? ''))
    } catch {
      return { uci, bad: san }
    }
  }
  return { uci, bad: null }
}

/** Positions compare equal without the move counters (FENs from different sources may differ there). */
export const samePosition = (a: string, b: string) => a.split(' ').slice(0, 4).join(' ') === b.split(' ').slice(0, 4).join(' ')
