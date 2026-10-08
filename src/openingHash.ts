// Shared by the app and scripts/build-openings.mjs (Node 24 runs this TypeScript file directly).

/** 32-bit FNV-1a hash of a FEN's position part: pieces, side to move, castling rights, en passant. */
export function positionHash(fen: string): number {
  const key = fen.split(' ').slice(0, 4).join(' ')
  let h = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h
}
