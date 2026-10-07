import type { EngineLine } from '../engine'
import { formatScore, pvToSan, type Label } from '../analysis'

interface Props {
  fen: string
  lines: EngineLine[]
  labels: Label[] // how each line compares with the best one
  onPlay: (uciMoves: string[]) => void
}

const QUALITY: Record<Label, { glyph: string; text: string }> = {
  best: { glyph: '★', text: 'As good as the best move' },
  good: { glyph: '✓', text: 'Slightly worse than the best move' },
  inaccuracy: { glyph: '?!', text: 'Inaccuracy compared with the best move' },
  mistake: { glyph: '?', text: 'Mistake compared with the best move' },
  blunder: { glyph: '??', text: 'Blunder compared with the best move' },
}

/** Top engine lines; tapping a move plays the line up to that move on the board. */
export function EngineLines({ fen, lines, labels, onPlay }: Props) {
  const [, turn, , , , full] = fen.split(' ')
  return (
    <div className="engine-lines">
      {lines.map((line, li) => {
        const sans = pvToSan(fen, line.pv, 10)
        let n = Number(full)
        const q = labels[li] ?? 'best'
        return (
          <div className={`engine-line q-${q}`} key={line.multipv}>
            <span className={`line-score ${isWhiteGood(line) ? 'pos' : 'neg'}`}>{formatScore(line.score)}</span>
            <span className="line-quality" title={QUALITY[q].text}>
              {QUALITY[q].glyph}
            </span>
            <span className="line-moves">
              {sans.map((san, i) => {
                const white = (turn === 'w') === (i % 2 === 0)
                const prefix = white ? `${n}. ` : i === 0 ? `${n}... ` : ''
                if (!white) n++
                return (
                  <button key={i} className="line-move" onClick={() => onPlay(line.pv.slice(0, i + 1))}>
                    {prefix && <span className="muted">{prefix}</span>}
                    {san}
                  </button>
                )
              })}
            </span>
          </div>
        )
      })}
    </div>
  )
}

function isWhiteGood(line: EngineLine) {
  return line.score.mate !== undefined ? line.score.mate > 0 : line.score.cp >= 0
}
