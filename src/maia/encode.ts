// lc0's input encoding (112 planes, the classical format Maia-1 was trained on) and its policy move order,
// after lc0 src/neural/encoder.cc. Everything is seen from the side to move: for Black the board is flipped.
import type { Move } from 'chess.js'
import LC0_MOVES from './lc0Moves.json'

const MOVE_INDEX = new Map((LC0_MOVES as string[]).map((m, i) => [m, i]))
const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR'
const PIECE: Record<string, number> = { p: 0, n: 1, b: 2, r: 3, q: 4, k: 5 }

/** Input planes for the last position of `history` (FENs, oldest first), with up to 7 earlier ones. */
export function encode(history: string[]): Float32Array {
  const planes = new Float32Array(112 * 64)
  const cur = history[history.length - 1].split(' ')
  const stm = cur[1]
  const position = (fen: string) => fen.split(' ').slice(0, 4).join(' ')
  for (let i = 0; i < 8; i++) {
    let h = history.length - 1 - i
    if (h < 0) {
      // Before the first known position: empty after the standard start, else the oldest one repeated
      if (history[0].split(' ')[0] === START) break
      h = 0
    }
    const fen = history[h]
    const rows = fen.split(' ')[0].split('/')
    for (let r = 0; r < 8; r++) {
      let file = 0
      for (const ch of rows[r]) {
        if (ch >= '1' && ch <= '8') {
          file += Number(ch)
          continue
        }
        const ours = (ch === ch.toUpperCase() ? 'w' : 'b') === stm
        let sq = (7 - r) * 8 + file
        if (stm === 'b') sq ^= 56
        planes[(i * 13 + (ours ? 0 : 6) + PIECE[ch.toLowerCase()]) * 64 + sq] = 1
        file++
      }
    }
    // Repetition: the position occurred earlier
    const key = position(fen)
    if (history.slice(0, h).some((f) => position(f) === key)) planes.fill(1, (i * 13 + 12) * 64, (i * 13 + 13) * 64)
  }
  const castling = cur[2]
  const [ourK, ourQ, theirK, theirQ] = stm === 'w' ? ['K', 'Q', 'k', 'q'] : ['k', 'q', 'K', 'Q']
  const fill = (plane: number, v: number) => planes.fill(v, plane * 64, (plane + 1) * 64)
  if (castling.includes(ourQ)) fill(104, 1)
  if (castling.includes(ourK)) fill(105, 1)
  if (castling.includes(theirQ)) fill(106, 1)
  if (castling.includes(theirK)) fill(107, 1)
  if (stm === 'b') fill(108, 1)
  fill(109, Number(cur[4])) // halfmove clock
  fill(111, 1)
  return planes
}

/** A legal move's index in the policy: castling as king takes rook, knight promotion as the plain move. */
export function policyIndex(m: Move, stm: 'w' | 'b'): number {
  let to = m.to as string
  if (m.flags.includes('k')) to = 'h' + m.from[1]
  if (m.flags.includes('q')) to = 'a' + m.from[1]
  let from = m.from as string
  if (stm === 'b') {
    from = from[0] + String(9 - Number(from[1]))
    to = to[0] + String(9 - Number(to[1]))
  }
  const promo = m.promotion && m.promotion !== 'n' ? m.promotion : ''
  const i = MOVE_INDEX.get(from + to + promo)
  if (i === undefined) throw new Error(`No policy index for ${m.lan}`)
  return i
}
