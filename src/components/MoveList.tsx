import { useEffect, useRef } from 'react'
import { GLYPH, type Game, type Review } from '../analysis'

interface Props {
  game: Game
  review: Review | null
  ply: number
  onSelect: (ply: number) => void
  bookPlies?: number // the first N plies are book moves
}

export function MoveList({ game, review, ply, onSelect, bookPlies = 0 }: Props) {
  const list = useRef<HTMLDivElement>(null)
  const active = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    // Scroll only the list itself; scrollIntoView would also scroll the page away from the board.
    const box = list.current
    const el = active.current
    if (!box || !el) return
    const top = el.offsetTop // .move-list is position: relative, so this is relative to the list
    if (top < box.scrollTop) box.scrollTop = top - 4
    else if (top + el.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = top + el.offsetHeight - box.clientHeight + 4
  }, [ply])

  const startNumber = Number(game.startFen.split(' ')[5] ?? 1)
  const rows: { n: number; w?: number; b?: number }[] = []
  game.plies.forEach((p, i) => {
    const idx = i + 1
    if (p.color === 'w' || i === 0) rows.push({ n: startNumber + rows.length, [p.color]: idx })
    else rows[rows.length - 1].b = idx
  })

  const cell = (idx?: number) => {
    if (!idx) return <span className="move empty">…</span>
    const p = game.plies[idx - 1]
    const book = idx <= bookPlies
    const r = book ? undefined : review?.moves[idx - 1]
    return (
      <button
        ref={idx === ply ? active : undefined}
        className={`move ${idx === ply ? 'active' : ''} ${r ? `lbl-${r.label}` : ''} ${book ? 'book' : ''}`}
        onClick={() => onSelect(idx)}
      >
        {p.san}
        {book && <span className="glyph book-glyph">📖</span>}
        {r && r.label !== 'best' && GLYPH[r.label] && <span className="glyph">{GLYPH[r.label]}</span>}
      </button>
    )
  }

  return (
    <div className="move-list" ref={list}>
      {rows.map((row) => (
        <div className="move-row" key={row.n}>
          <span className="move-no">{row.n}.</span>
          {cell(row.w)}
          {cell(row.b)}
        </div>
      ))}
      {game.plies.length > 0 && <div className="move-result">{game.meta.result}</div>}
    </div>
  )
}
