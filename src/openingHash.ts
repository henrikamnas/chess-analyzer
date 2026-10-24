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

/**
 * 64-bit key of a FEN's position part as 16 hex digits (FNV-1a plus a second, independent hash), for the
 * move statistics in public/explorer: hundreds of thousands of positions, too many for 32 bits.
 */
export function positionKey(fen: string): string {
  const key = fen.split(' ').slice(0, 4).join(' ')
  let h2 = 0x9e3779b9
  for (let i = 0; i < key.length; i++) {
    h2 = Math.imul(h2 ^ key.charCodeAt(i), 0x5bd1e995)
    h2 ^= h2 >>> 15
  }
  h2 = Math.imul(h2 ^ (h2 >>> 13), 0xc2b2ae35) >>> 0
  return positionHash(fen).toString(16).padStart(8, '0') + ((h2 ^ (h2 >>> 16)) >>> 0).toString(16).padStart(8, '0')
}
