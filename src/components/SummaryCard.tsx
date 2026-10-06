import { useMemo } from 'react'
import { GLYPH, type Game, type Label, type Review } from '../analysis'
import { moveName, rating, summarizeGame } from '../explain'

interface Props {
  game: Game
  review: Review
  onSelect: (ply: number) => void
}

const ERRORS: Label[] = ['blunder', 'mistake', 'inaccuracy']

export function SummaryCard({ game, review, onSelect }: Props) {
  const summary = useMemo(() => summarizeGame(game, review), [game, review])
  const { meta } = game

  const player = (c: 'w' | 'b') => {
    const est = review.rating[c]
    const actual = c === 'w' ? meta.whiteElo : meta.blackElo
    return (
      <div className="stat-block">
        <div className="stat-name">
          <span className={`swatch ${c}`} />
          {c === 'w' ? meta.white : meta.black}
        </div>
        <div className="stat-acc">{review.accuracy[c].toFixed(1)}%</div>
        <div className="stat-est" title={`Average centipawn loss ${Math.round(review.acpl[c])}`}>
          Played like ~{est.value}
          {!est.reliable && '?'}
          {actual && <span className="muted"> · rated {actual}</span>}
        </div>
        <div className="stat-errors">
          {ERRORS.map((l) => (
            <span key={l} className={`err-chip lbl-${l} ${review.counts[c][l] ? '' : 'zero'}`} title={l}>
              <span className="glyph">{GLYPH[l]}</span> {review.counts[c][l]}
            </span>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="summary-card">
      <div className="stat-blocks">
        {player('w')}
        {player('b')}
      </div>

      {summary.paragraphs.map((p, i) => (
        <p key={i}>{p}</p>
      ))}

      <div className="phases" style={{ gridTemplateColumns: `auto repeat(${summary.phases.length}, 1fr)` }}>
        <span />
        {summary.phases.map((ph) => (
          <span key={ph.phase} className="phase-head">{ph.phase}</span>
        ))}
        {(['w', 'b'] as const).map((c) => (
          <PhaseRow key={c} label={c === 'w' ? 'White' : 'Black'} values={summary.phases.map((ph) => ph[c])} />
        ))}
      </div>

      {summary.moments.length > 0 && (
        <>
          <h3>Key moments</h3>
          <ul className="moments">
            {summary.moments.map((m) => (
              <li key={m.ply}>
                <button className={`moment lbl-${m.label}`} onClick={() => onSelect(m.ply)}>
                  <strong>
                    {moveName(game, m.ply - 1)}
                    <span className="glyph">{GLYPH[m.label]}</span>
                  </strong>
                  <span>{m.text}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

function PhaseRow({ label, values }: { label: string; values: (number | null)[] }) {
  return (
    <>
      <span className="muted">{label}</span>
      {values.map((v, i) =>
        v === null ? (
          <span key={i} className="muted">–</span>
        ) : (
          <span key={i} className={`phase-val r-${rating(v).toLowerCase()}`} title={rating(v)}>
            {v.toFixed(0)}
          </span>
        ),
      )}
    </>
  )
}
