import { useEffect, useMemo, useRef, useState } from 'react'
import { familyOf, linesFor, loadOpeningLines, suggestedSide, variationOf, type OpeningLine } from '../openingLines'
import { LEVELS } from './PlayCard'
import type { BotStrength } from '../bot'
import { t } from '../i18n'
import { BANDS, bandOf, lichessRating } from '../explorer'
import { maiaRating } from '../maia'
import { lineDifficulty, type Difficulty } from '../lineDifficulty'

const LIST_RATED = 30 // openings in the list of all openings that get a difficulty, from the top
const linesText = (n: number) => (n === 1 ? t('1 line') : t('{n} lines', { n }))
const pct = (x: number) => (x < 0.01 ? '<1' : String(Math.round(100 * x)))

/** The difficulty as a small coloured label. */
function DiffBadge({ d }: { d: Difficulty | undefined }) {
  if (!d) return null
  return (
    <span className={`diff ${d.rating}`} title={t('Difficulty from 1 (easy) to 10 (hard)')}>
      {t(d.rating)} {d.score}/10
    </span>
  )
}

export interface TrainingStart {
  selection: string // family or "family: variation"
  lines: OpeningLine[]
  all: OpeningLine[] // every named line, to name positions on the way into the chosen opening
  side: 'w' | 'b' // the side the user plays
  strength: BotStrength // the computer's level: which players' move choices it follows, and its engine strength after
  tricky: boolean // favour the book moves that score best against players at that level
}

/** Opening practice: find an opening, pick a variation (or all of it) and a side, then play it against the computer. */
export function OpeningPicker({ onStart }: { onStart: (s: TrainingStart) => void }) {
  const [all, setAll] = useState<OpeningLine[] | null>(null)
  const [query, setQuery] = useState('')
  const [family, setFamily] = useState<string | null>(null)
  const [selection, setSelection] = useState<string | null>(null)
  const [side, setSide] = useState<'w' | 'b'>('b')
  const [strength, setStrength] = useState<string>('1200')
  const [tricky, setTricky] = useState(false)
  // How hard each selection is for the chosen side and level, keyed "selection|side|strength"
  const [difficulty, setDifficulty] = useState<Map<string, Difficulty>>(new Map())
  const working = useRef(new Set<string>())

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

  // Rates the chosen selection first, then the family and each variation, one at a time in the background. In the
  // list of all openings, each opening is rated for the side that usually plays it (Black for defences).
  const diffKey = (sel: string, s: 'w' | 'b' = side) => `${sel}|${s}|${strength}`
  useEffect(() => {
    if (!all) return
    let cancelled = false
    const level = strength === 'max' ? null : Number(strength)
    const band = level === null ? BANDS.length : bandOf(lichessRating(level))
    const net = (level === null ? null : maiaRating(lichessRating(level))) ?? 1900
    const todo: [string, 'w' | 'b'][] = family
      ? [...new Set([...(selection ? [selection] : []), family, ...variations.map(([v]) => `${family}: ${v}`)])].map((sel) => [sel, side])
      : families.slice(0, LIST_RATED).map(([name]) => [name, suggestedSide(name)])
    void (async () => {
      for (const [sel, s] of todo) {
        const key = diffKey(sel, s)
        if (cancelled) return
        if (working.current.has(key)) continue
        working.current.add(key)
        const d = await lineDifficulty(linesFor(all, sel), s, band, net, () => cancelled)
        if (!d) {
          working.current.delete(key) // cancelled half-way: rate it again next time
          return
        }
        setDifficulty((m) => new Map(m).set(key, d))
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all, family, families, variations, selection, side, strength])

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
            <div className="muted small">
              {t('Difficulty for {who}, playing the side the opening belongs to (Black in defences).', {
                who: strength === 'max' ? t('strong players') : t('players rated about {rating}', { rating: strength }),
              })}
            </div>
            <div className="opening-list">
              {families.slice(0, 60).map(([name, n]) => (
                <button
                  key={name}
                  onClick={() => {
                    setFamily(name)
                    setSide(suggestedSide(name))
                  }}
                >
                  <span>{name}</span>
                  <span className="muted">
                    <DiffBadge d={difficulty.get(diffKey(name, suggestedSide(name)))} /> {linesText(n)}
                  </span>
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
                <span className="muted">
                  <DiffBadge d={difficulty.get(diffKey(family))} /> {linesText(linesFor(all, family).length)}
                </span>
              </button>
              {variations.map(([v, n]) => (
                <button key={v} className={selection === `${family}: ${v}` ? 'on' : ''} onClick={() => choose(`${family}: ${v}`)}>
                  <span>{v}</span>
                  <span className="muted">
                    <DiffBadge d={difficulty.get(diffKey(`${family}: ${v}`))} /> {linesText(n)}
                  </span>
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
            <span>{t('Opponent')}</span>
            <select value={strength} onChange={(e) => setStrength(e.target.value)}>
              {LEVELS.map((r) => (
                <option key={r} value={String(r)}>
                  {t('rated about {rating}', { rating: r })}
                </option>
              ))}
              <option value="max">{t('full strength')}</option>
            </select>
          </label>
          <div className="play-row">
            <span>{t('Computer plays')}</span>
            <span className="seg" role="group" aria-label={t('Computer plays')}>
              <button className={!tricky ? 'on' : ''} onClick={() => setTricky(false)}>
                {t('Popular moves')}
              </button>
              <button className={tricky ? 'on' : ''} onClick={() => setTricky(true)}>
                {t('Tricky lines')}
              </button>
            </span>
          </div>
          <div className="muted small">
            {tricky
              ? t('The computer favours the moves that score best against players at that level: the lines people tend to get wrong.')
              : t('The computer picks book moves as often as players at that level play them on Lichess, and keeps playing like them while there is data.')}
          </div>
          <DifficultyNote d={difficulty.get(diffKey(selection))} side={side} who={strength === 'max' ? t('strong players') : t('players rated about {rating}', { rating: strength })} />
          <div className="row">
            <button className="primary" onClick={() => onStart({ selection, lines, all, side, strength: strength === 'max' ? null : Number(strength), tricky })}>
              ▶ {t('Start practice')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/** The selection's difficulty for the side: how many tricky moves, where they come, and the chance of a clean run. */
function DifficultyNote({ d, side, who }: { d: Difficulty | undefined; side: 'w' | 'b'; who: string }) {
  if (!d) return <div className="muted small">{t('Rating the difficulty…')}</div>
  const n = d.tricky.length
  return (
    <div className="difficulty-note small">
      <div>
        {t('Difficulty for {who} playing {side}:', { who, side: t(side === 'w' ? 'White' : 'Black').toLowerCase() })} <DiffBadge d={d} />{' '}
        {n === 0 ? t('no tricky moves') : n === 1 ? t('1 tricky move') : t('{n} tricky moves', { n })}
      </div>
      {n > 0 && (
        <div className="muted">
          {t('Tricky moments: {list}.', {
            list: d.tricky
              .slice(0, 4)
              .map((m) => (m.after ? t('after {move} ({n}% find a good reply)', { move: m.after, n: pct(m.p) }) : t('your first move ({n}%)', { n: pct(m.p) })))
              .join(', '),
          })}
        </div>
      )}
      <div className="muted">{t('Chance of playing the whole book line without a slip: about {n}%.', { n: pct(d.clean) })}</div>
    </div>
  )
}
