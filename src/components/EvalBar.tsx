import type { Score } from '../engine'
import { formatScore, winPercent } from '../analysis'

export function EvalBar({ score, orientation }: { score: Score | null; orientation: 'white' | 'black' }) {
  const white = score ? winPercent(score) : 50
  const text = score ? formatScore(score) : ''
  const whiteAhead = white >= 50
  return (
    <div className={`eval-bar ${orientation === 'black' ? 'flipped' : ''}`}>
      <div className="eval-bar-white" style={{ height: `${white}%` }} />
      <span className={`eval-bar-text ${whiteAhead ? 'on-white' : 'on-black'}`}>{text.replace('+', '')}</span>
    </div>
  )
}
