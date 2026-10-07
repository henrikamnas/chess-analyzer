import type { EngineLine, Score } from '../engine'
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

/** Centipawns for the side to move; mates count as huge values so they compare correctly. */
function moverCp(score: Score, whiteToMove: boolean) {
  const cp = score.mate !== undefined ? Math.sign(score.mate) * (100000 - Math.abs(score.mate) * 100) : score.cp
  return whiteToMove ? cp : -cp
}

/** How much worse a line is than the best line, as short text: "−1.8", "=", "allows mate", "misses mate". */
function costText(best: Score, line: Score, whiteToMove: boolean): { short: string; long: string } {
  const b = moverCp(best, whiteToMove)
  const l = moverCp(line, whiteToMove)
  const mateFor = (cp: number) => Math.abs(cp) >= 50000
  if (mateFor(l) && l < 0 && !(mateFor(b) && b < 0)) return { short: 'allows mate', long: 'This line allows a forced mate' }
  if (mateFor(b) && b > 0 && !(mateFor(l) && l > 0)) return { short: 'misses mate', long: 'The best line forces mate; this one does not' }
  const diff = Math.max(0, b - l) / 100
  if (diff < 0.05) return { short: '=', long: 'As good as the best line' }
  return { short: `−${diff.toFixed(1)}`, long: `${diff.toFixed(1)} pawns worse than the best line` }
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
        const cost = li > 0 ? costText(lines[0].score, line.score, turn === 'w') : null
        return (
          <div className={`engine-line q-${q}`} key={line.multipv}>
            <span className={`line-score ${isWhiteGood(line) ? 'pos' : 'neg'}`}>{formatScore(line.score)}</span>
            <span className="line-quality" title={cost ? `${QUALITY[q].text}: ${cost.long}` : 'Best line'}>
              {QUALITY[q].glyph}
              {cost && <span className="line-cost">{cost.short}</span>}
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
