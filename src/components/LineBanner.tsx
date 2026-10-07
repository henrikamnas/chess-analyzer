import { useEffect, useRef, useState } from 'react'
import { pvToSan } from '../analysis'
import { t } from '../i18n'

interface Props {
  title: string
  note?: string // explanation of what the line shows; tap to expand on small screens
  kind: 'why' | 'best' | 'line'
  fen: string // position the line starts from
  moves: string[] // UCI
  current: number // how many of `moves` are on the board
  onSelect: (count: number) => void
  onExit: () => void
}

/** Shows that the board is off the game, in a side line, and lets you jump to any move in it. */
export function LineBanner({ title, note, kind, fen, moves, current, onSelect, onExit }: Props) {
  const [expanded, setExpanded] = useState(false)
  const sans = pvToSan(fen, moves, moves.length)
  const [, turn, , , , full] = fen.split(' ')
  let n = Number(full)
  const row = useRef<HTMLDivElement>(null)
  const active = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    // Scroll only the move row horizontally; scrollIntoView would also scroll the page.
    const box = row.current
    const el = active.current
    if (!box || !el) return
    const left = el.offsetLeft // .line-moves-row is position: relative
    if (left < box.scrollLeft) box.scrollLeft = left - 8
    else if (left + el.offsetWidth > box.scrollLeft + box.clientWidth) box.scrollLeft = left + el.offsetWidth - box.clientWidth + 8
  }, [current])

  return (
    <div className={`line-banner kind-${kind}`}>
      <div className="line-banner-head">
        <span className="line-tag">{t(kind === 'line' ? 'Side line' : kind === 'why' ? "Why it's bad" : 'Better move')}</span>
        <span className="line-count muted">
          {current}/{sans.length}
        </span>
        <button className="line-exit" onClick={onExit} aria-label={t('Back to game')}>
          ✕
        </button>
      </div>
      <div className="line-title">{title}</div>
      {note && (
        <button className={`line-note ${expanded ? 'expanded' : ''}`} onClick={() => setExpanded((e) => !e)}>
          {note}
        </button>
      )}
      <div className="line-moves-row" ref={row}>
        <button className={`lm start ${current === 0 ? 'on' : ''}`} onClick={() => onSelect(0)} title={t('Start of line')}>
          ·
        </button>
        {sans.map((san, i) => {
          const white = (turn === 'w') === (i % 2 === 0)
          const prefix = white ? `${n}.` : i === 0 ? `${n}...` : ''
          if (!white) n++
          return (
            <button
              key={i}
              ref={i + 1 === current ? active : undefined}
              className={`lm ${i + 1 === current ? 'on' : ''} ${i + 1 > current ? 'ahead' : ''}`}
              onClick={() => onSelect(i + 1)}
            >
              {prefix && <span className="muted">{prefix}</span>}
              {san}
            </button>
          )
        })}
      </div>
    </div>
  )
}
