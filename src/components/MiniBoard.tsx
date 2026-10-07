// A small static board for lists: a CSS grid with piece glyphs (much lighter than a chessground board per row).
const GLYPH: Record<string, string> = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' }

export function MiniBoard({ fen, orientation }: { fen: string; orientation: 'w' | 'b' }) {
  const rows = fen.split(' ')[0].split('/')
  const squares: { piece: string | null; dark: boolean }[] = []
  rows.forEach((row, r) => {
    let f = 0
    for (const ch of row) {
      if (/\d/.test(ch)) {
        for (let k = 0; k < Number(ch); k++, f++) squares.push({ piece: null, dark: (r + f) % 2 === 1 })
      } else {
        squares.push({ piece: ch, dark: (r + f) % 2 === 1 })
        f++
      }
    }
  })
  const ordered = orientation === 'w' ? squares : [...squares].reverse()
  return (
    <div className="mini-board" aria-hidden="true">
      {ordered.map((sq, i) => (
        <span key={i} className={`mini-sq ${sq.dark ? 'dark' : 'light'}`}>
          {sq.piece && <span className={sq.piece === sq.piece.toUpperCase() ? 'mp w' : 'mp b'}>{GLYPH[sq.piece.toLowerCase()]}</span>}
        </span>
      ))}
    </div>
  )
}
