import { useMemo } from 'react'
import { basisName, GLYPH, type Game, type Label, type Review } from '../analysis'
import { moveName, phaseName, rating, ratingName, summarizeGame } from '../explain'
import { t, useLang } from '../i18n'
import type { BookInfo } from '../openings'

export interface DeepState {
  status: 'idle' | 'running' | 'done'
  done: number
  total: number
  startedAt: number // epoch ms
  elapsedMs: number // as of the last finished position
}

interface Props {
  game: Game
  review: Review
  onSelect: (ply: number) => void
  deep: DeepState
  onDeep: () => void
  book?: BookInfo | null
}

const ERRORS: Label[] = ['blunder', 'mistake', 'inaccuracy']

export function SummaryCard({ game, review, onSelect, deep, onDeep, book }: Props) {
  const lang = useLang()
  // eslint-disable-next-line react-hooks/exhaustive-deps -- lang: the summary text is generated in the current language
  const summary = useMemo(() => summarizeGame(game, review, book), [game, review, book, lang])
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
        <div className="stat-est" title={t('Average centipawn loss {n}', { n: Math.round(review.acpl[c]) })}>
          {t('Played like ~{n}', { n: est.value })}
          {!est.reliable && '?'}
          {actual && <span className="muted"> · {t('rated {n}', { n: actual })}</span>}
        </div>
        <div className="stat-basis muted">
          {est.calibrated
            ? t('vs {basis} players', { basis: basisName(est.basis) })
            : t('{basis} equivalent (no calibration for this game type)', { basis: basisName(est.basis) })}
          {est.precision === 'rough' && t(' · rough: single fast games vary a lot')}
        </div>
        <div className="stat-errors">
          {ERRORS.map((l) => (
            <span key={l} className={`err-chip lbl-${l} ${review.counts[c][l] ? '' : 'zero'}`} title={t(l)}>
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

      <DeepAnalysis deep={deep} onDeep={onDeep} />

      {summary.paragraphs.map((p, i) => (
        <p key={i}>{p}</p>
      ))}

      <div className="phases" style={{ gridTemplateColumns: `auto repeat(${summary.phases.length}, 1fr)` }}>
        <span />
        {summary.phases.map((ph) => (
          <span key={ph.phase} className="phase-head">{phaseName(ph.phase)}</span>
        ))}
        {(['w', 'b'] as const).map((c) => (
          <PhaseRow key={c} label={t(c === 'w' ? 'White' : 'Black')} values={summary.phases.map((ph) => ph[c])} />
        ))}
      </div>

      {summary.moments.length > 0 && (
        <>
          <h3>{t('Key moments')}</h3>
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
          <span key={i} className={`phase-val r-${rating(v)}`} title={ratingName(rating(v))}>
            {v.toFixed(0)}
          </span>
        ),
      )}
    </>
  )
}

function DeepAnalysis({ deep, onDeep }: { deep: DeepState; onDeep: () => void }) {
  if (deep.status === 'done') {
    return <div className="deep done">✓ {t('Deep analysis · full Stockfish 19')}</div>
  }
  if (deep.status === 'running') {
    const elapsed = deep.elapsedMs / 1000
    const left = deep.done > 2 ? Math.round(((deep.total - deep.done) * elapsed) / deep.done) : null
    return (
      <div className="deep running">
        <div className="muted">
          {t('Deep analysis… {done}/{total}', { done: deep.done, total: deep.total })}
          {left !== null && t(' · about {time} left', { time: left < 90 ? `${left} s` : `${Math.round(left / 60)} min` })}
        </div>
        <div className="bar">
          <div style={{ width: `${(deep.done / deep.total) * 100}%` }} />
        </div>
      </div>
    )
  }
  return (
    <div className="deep">
      <button onClick={onDeep}>🔬 {t('Deep analysis')}</button>
      <span className="muted">{t('Re-check every move with the full engine (takes a few minutes)')}</span>
    </div>
  )
}
