import type { EngineLine } from '../engine'
import { formatScore, pvToSan } from '../analysis'

interface Props {
  fen: string
  lines: EngineLine[]
  onPlay: (uciMoves: string[]) => void
}

/** Top engine lines; tapping a move plays the line up to that move on the board. */
export function EngineLines({ fen, lines, onPlay }: Props) {
  const [, turn, , , , full] = fen.split(' ')
  return (
    <div className="engine-lines">
      {lines.map((line) => {
        const sans = pvToSan(fen, line.pv, 10)
        let n = Number(full)
        return (
          <div className="engine-line" key={line.multipv}>
            <span className={`line-score ${isWhiteGood(line) ? 'pos' : 'neg'}`}>{formatScore(line.score)}</span>
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
