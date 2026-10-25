import { useEffect, useState } from 'react'
import { uciToSan } from '../analysis'
import { lichessRating } from '../explorer'
import { maiaMoves, maiaRating } from '../maia'
import { t } from '../i18n'

const LEVEL_KEY = 'chess-analyzer:human-level'
// Chess.com ratings Maia covers (its networks span Lichess 1100–1900)
const HUMAN_LEVELS = [600, 800, 1000, 1200, 1400, 1600, 1800]

function storedLevel(): number | null {
  try {
    const v = Number(localStorage.getItem(LEVEL_KEY))
    return HUMAN_LEVELS.includes(v) ? v : null
  } catch {
    return null
  }
}

export interface HumanTop {
  fen: string
  uci: string
  p: number
}

/**
 * Next to the engine lines: the moves a human of the chosen rating would most likely play here (Maia), so you
 * can see what's natural at that level as well as what's best. Tapping a move plays it on the board; the most
 * likely one is reported through `onTop` for an arrow on the board.
 */
export function HumanMoves({ history, onPlay, onTop }: { history: string[]; onPlay: (uci: string[]) => void; onTop: (top: HumanTop | null) => void }) {
  const [level, setLevel] = useState<number | null>(storedLevel)
  const fen = history[history.length - 1]
  const [moves, setMoves] = useState<{ fen: string; level: number; list: { uci: string; p: number }[] } | null>(null)

  useEffect(() => {
    if (level === null) return
    const net = maiaRating(lichessRating(level))
    if (!net) return
    let live = true
    // A short pause, so stepping quickly through a game doesn't queue a prediction for every position
    const timer = setTimeout(() => {
      maiaMoves(history.slice(-8), net).then(
        (list) => live && setMoves({ fen, level, list }),
        () => live && setMoves({ fen, level, list: [] }),
      )
    }, 150)
    return () => {
      live = false
      clearTimeout(timer)
    }
    // history changes identity on every render; the position and level are what matter
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fen, level])

  const choose = (v: string) => {
    const next = v ? Number(v) : null
    setLevel(next)
    try {
      if (next === null) localStorage.removeItem(LEVEL_KEY)
      else localStorage.setItem(LEVEL_KEY, String(next))
    } catch {
      /* storage unavailable */
    }
  }

  const shown = moves && moves.fen === fen && moves.level === level ? moves.list.filter((m) => m.p >= 0.05).slice(0, 4) : null
  const top = level !== null ? shown?.[0] : undefined
  useEffect(() => {
    onTop(top ? { fen, uci: top.uci, p: top.p } : null)
    // onTop is a state setter; the move shown is what matters
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fen, top?.uci, top?.p])
  useEffect(() => () => onTop(null), [onTop])
  return (
    <div className="human-moves">
      <select value={level ?? ''} onChange={(e) => choose(e.target.value)} aria-label={t('Human moves')} title={t('What a human of this rating would most likely play here (Maia)')}>
        <option value="">👥 {t('Human moves: off')}</option>
        {HUMAN_LEVELS.map((r) => (
          <option key={r} value={r}>
            👥 {t('Human ~{rating}', { rating: r })}
          </option>
        ))}
      </select>
      {level !== null &&
        (shown ? (
          <span className="human-list">
            {shown.map((m) => (
              <button key={m.uci} className="line-move" onClick={() => onPlay([m.uci])}>
                {uciToSan(fen, m.uci)} <span className="muted">{Math.round(m.p * 100)}%</span>
              </button>
            ))}
          </span>
        ) : (
          <span className="muted small">…</span>
        ))}
    </div>
  )
}
