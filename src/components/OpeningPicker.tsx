import { useEffect, useMemo, useState } from 'react'
import { familyOf, linesFor, loadOpeningLines, suggestedSide, variationOf, type OpeningLine } from '../openingLines'
import { LEVELS } from './PlayCard'
import type { BotStrength } from '../bot'
import { t } from '../i18n'

const linesText = (n: number) => (n === 1 ? t('1 line') : t('{n} lines', { n }))

export interface TrainingStart {
  selection: string // family or "family: variation"
  lines: OpeningLine[]
  all: OpeningLine[] // every named line, to name positions on the way into the chosen opening
  side: 'w' | 'b' // the side the user plays
  strength: BotStrength // how the computer plays once the book runs out
}

/** Opening practice: find an opening, pick a variation (or all of it) and a side, then play it against the computer. */
export function OpeningPicker({ onStart }: { onStart: (s: TrainingStart) => void }) {
  const [all, setAll] = useState<OpeningLine[] | null>(null)
  const [query, setQuery] = useState('')
  const [family, setFamily] = useState<string | null>(null)
  const [selection, setSelection] = useState<string | null>(null)
  const [side, setSide] = useState<'w' | 'b'>('b')
  const [strength, setStrength] = useState<string>('1200')

  useEffect(() => {
    void loadOpeningLines().then(setAll)
  }, [])

  // Families matching the search (by their own name or a variation's), most lines first
  const families = useMemo(() => {
    if (!all) return []
    const q = query.trim().toLowerCase()
    const counts = new Map<string, number>()
    for (const l of all) {
      if (q && !l.name.toLowerCase().includes(q)) continue
      counts.set(familyOf(l.name), (counts.get(familyOf(l.name)) ?? 0) + 1)
    }
    // Openings whose own name matches first ("slav": the Slav before the Sicilian's Yugoslav Attack)
    const own = (name: string) => (name.toLowerCase().includes(q) ? 0 : 1)
    return [...counts].sort((a, b) => own(a[0]) - own(b[0]) || b[1] - a[1] || a[0].localeCompare(b[0]))
  }, [all, query])

  const variations = useMemo(() => {
    if (!all || !family) return []
    const counts = new Map<string, number>()
    for (const l of linesFor(all, family)) {
      const v = variationOf(l.name)
      if (v) counts.set(v, (counts.get(v) ?? 0) + 1)
    }
    return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  }, [all, family])

  const choose = (sel: string) => {
    setSelection(sel)
    setSide(suggestedSide(sel))
  }

  if (!all) return <div className="card muted">{t('Loading openings…')}</div>

  const lines = selection ? linesFor(all, selection) : []

  return (
    <div className="opening-picker">
      <div className="card">
        <h2>📖 {t('Practise an opening')}</h2>
        <p className="muted">
          {t('The computer plays book moves of the opening you pick, varying between its lines, and tells you when you leave the book. When the book runs out, it plays on.')}
        </p>
        {!family ? (
          <>
            <input
              className="opening-search"
              type="search"
              placeholder={t('Search, e.g. Slav or Sicilian')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoFocus
            />
            <div className="opening-list">
              {families.slice(0, 60).map(([name, n]) => (
                <button key={name} onClick={() => setFamily(name)}>
                  <span>{name}</span>
                  <span className="muted">{linesText(n)}</span>
                </button>
              ))}
              {families.length === 0 && <div className="muted">{t('No openings match.')}</div>}
            </div>
          </>
        ) : (
          <>
            <button
              className="link"
              onClick={() => {
                setFamily(null)
                setSelection(null)
              }}
            >
              ← {t('All openings')}
            </button>
            <h3>{family}</h3>
            <div className="opening-list">
              <button className={selection === family ? 'on' : ''} onClick={() => choose(family)}>
                <span>{t('All lines')}</span>
                <span className="muted">{linesText(linesFor(all, family).length)}</span>
              </button>
              {variations.map(([v, n]) => (
                <button key={v} className={selection === `${family}: ${v}` ? 'on' : ''} onClick={() => choose(`${family}: ${v}`)}>
                  <span>{v}</span>
                  <span className="muted">{linesText(n)}</span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      {selection && (
        <div className="card play-setup">
          <strong>{selection}</strong>
          <div className="muted small">{t('{n} lines, up to {moves} moves deep', { n: lines.length, moves: Math.ceil(Math.max(...lines.map((l) => l.moves.length)) / 2) })}</div>
          <div className="play-row">
            <span>{t('You play')}</span>
            <span className="seg" role="group" aria-label={t('You play')}>
              <button className={side === 'w' ? 'on' : ''} onClick={() => setSide('w')}>
                {t('White')}
              </button>
              <button className={side === 'b' ? 'on' : ''} onClick={() => setSide('b')}>
                {t('Black')}
              </button>
            </span>
          </div>
          <label className="play-row">
            <span>{t('After the book')}</span>
            <select value={strength} onChange={(e) => setStrength(e.target.value)}>
              {LEVELS.map((r) => (
                <option key={r} value={String(r)}>
                  {t('rated about {rating}', { rating: r })}
                </option>
              ))}
              <option value="max">{t('full strength')}</option>
            </select>
          </label>
          <div className="row">
            <button className="primary" onClick={() => onStart({ selection, lines, all, side, strength: strength === 'max' ? null : Number(strength) })}>
              ▶ {t('Start practice')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
