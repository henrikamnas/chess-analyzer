// The pieces a player has taken, next to their name (like Chess.com), with their material lead.
import { createElement } from 'react'

const START: Record<string, number> = { p: 8, n: 2, b: 2, r: 2, q: 1 }
const VALUE: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9 }
const NAME: Record<string, string> = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen' }

/** Pieces of each colour on the board, by type. */
function count(fen: string) {
  const out = { w: { p: 0, n: 0, b: 0, r: 0, q: 0 } as Record<string, number>, b: { p: 0, n: 0, b: 0, r: 0, q: 0 } as Record<string, number> }
  for (const ch of fen.split(' ')[0]) {
    const t = ch.toLowerCase()
    if (t in START) out[ch === t ? 'b' : 'w'][t]++
  }
  return out
}

/** The opponent's pieces missing from the board, i.e. taken by `side`. A promoted pawn counts as the pawn. */
function taken(onBoard: Record<string, number>) {
  const missing: Record<string, number> = {}
  let promoted = 0
  for (const t of ['n', 'b', 'r', 'q']) {
    missing[t] = Math.max(0, START[t] - onBoard[t])
    promoted += Math.max(0, onBoard[t] - START[t])
  }
  missing.p = Math.max(0, START.p - onBoard.p - promoted)
  return missing
}

export function Captured({ fen, side }: { fen: string; side: 'w' | 'b' }) {
  const pieces = count(fen)
  const opp = side === 'w' ? 'b' : 'w'
  const missing = taken(pieces[opp])
  const material = (c: 'w' | 'b') => Object.entries(pieces[c]).reduce((sum, [t, n]) => sum + VALUE[t] * n, 0)
  const lead = material(side) - material(opp)
  const color = opp === 'w' ? 'white' : 'black'
  return (
    <span className="captured cg-wrap">
      {['p', 'n', 'b', 'r', 'q'].map(
        (t) =>
          missing[t] > 0 && (
            <span key={t} className="captured-group">
              {Array.from({ length: missing[t] }, (_, i) => (
                // <piece> inside .cg-wrap picks up the board's piece images
                createElement('piece', { key: i, className: `${NAME[t]} ${color}` })
              ))}
            </span>
          ),
      )}
      {lead > 0 && <span className="captured-lead">+{lead}</span>}
    </span>
  )
}
