import type { PositionEval, Review } from '../analysis'
import { winPercent } from '../analysis'

interface Props {
  evals: PositionEval[]
  total: number // number of positions in the game
  review: Review | null
  ply: number
  onSelect: (ply: number) => void
}

const W = 600
const H = 90

export function EvalGraph({ evals, total, review, ply, onSelect }: Props) {
  if (total < 2) return null
  const x = (i: number) => (i / (total - 1)) * W
  const y = (e: PositionEval) => H - (winPercent(e.score) / 100) * H
  const points = evals.map((e, i) => `${x(i).toFixed(1)},${y(e).toFixed(1)}`)
  const area = points.length ? `M0,${H} L${points.join(' L')} L${x(evals.length - 1)},${H} Z` : ''

  const pick = (ev: React.PointerEvent<SVGSVGElement>) => {
    const rect = ev.currentTarget.getBoundingClientRect()
    const i = Math.round(((ev.clientX - rect.left) / rect.width) * (total - 1))
    onSelect(Math.max(0, Math.min(total - 1, i)))
  }

  return (
    <div className="eval-graph-wrap">
      <svg className="eval-graph" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" onPointerDown={pick}>
        <rect width={W} height={H} className="eval-graph-bg" />
        {area && <path d={area} className="eval-graph-area" />}
        <line x1={0} x2={W} y1={H / 2} y2={H / 2} className="eval-graph-mid" />
        <line x1={x(ply)} x2={x(ply)} y1={0} y2={H} className="eval-graph-cursor" vectorEffect="non-scaling-stroke" />
      </svg>
      {review?.moves.map((m, i) =>
        m.label === 'blunder' || m.label === 'mistake' ? (
          <span
            key={i}
            className={`graph-dot dot-${m.label}`}
            style={{ left: `${(x(i + 1) / W) * 100}%`, top: `${(y(review.evals[i + 1]) / H) * 100}%` }}
          />
        ) : null,
      )}
    </div>
  )
}
