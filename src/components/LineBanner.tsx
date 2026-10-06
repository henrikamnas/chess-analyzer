import { useEffect, useRef } from 'react'
import { pvToSan } from '../analysis'

interface Props {
  title: string
  kind: 'why' | 'best' | 'line'
  fen: string // position the line starts from
  moves: string[] // UCI
  current: number // how many of `moves` are on the board
  onSelect: (count: number) => void
  onExit: () => void
}

/** Shows that the board is off the game, in a side line, and lets you jump to any move in it. */
export function LineBanner({ title, kind, fen, moves, current, onSelect, onExit }: Props) {
  const sans = pvToSan(fen, moves, moves.length)
  const [, turn, , , , full] = fen.split(' ')
  let n = Number(full)
  const active = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    active.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [current])

  return (
    <div className={`line-banner kind-${kind}`}>
      <div className="line-banner-head">
        <span className="line-tag">{kind === 'line' ? 'Side line' : kind === 'why' ? 'Refutation' : 'Best line'}</span>
        <span className="line-title">{title}</span>
        <span className="line-count muted">
          {current}/{sans.length}
        </span>
        <button className="line-exit" onClick={onExit} aria-label="Back to game">
          ✕
        </button>
      </div>
      <div className="line-moves-row">
        <button className={`lm start ${current === 0 ? 'on' : ''}`} onClick={() => onSelect(0)} title="Start of line">
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
