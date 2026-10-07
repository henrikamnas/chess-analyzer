import { useCallback, useEffect, useRef, useState } from 'react'
import { runBatch, type BatchProgress } from '../batch'
import type { Source, TimeClass } from '../imports'
import { buildReport, type Insight, type PatternReport } from '../patterns'
import { MOTIF_NAME } from '../tactics'
import { getStoredGame, storedGamesFor, type StoredGame } from '../store'

interface Props {
  onOpen: (game: StoredGame, ply: number, me: 'w' | 'b') => void
}

interface Prefs {
  source: Source
  user: string
  timeClass: TimeClass | 'all'
  count: number
}

const PREFS_KEY = 'chess-analyzer:patterns'
const IMPORT_KEY = 'chess-analyzer:import'
const COUNTS = [10, 30, 50, 100]
const CLASSES: { value: Prefs['timeClass']; label: string }[] = [
  { value: 'rapid', label: 'Rapid' },
  { value: 'blitz', label: 'Blitz' },
  { value: 'bullet', label: 'Bullet' },
  { value: 'classical', label: 'Classical' },
  { value: 'daily', label: 'Daily' },
  { value: 'all', label: 'All' },
]

function loadPrefs(): Prefs {
  const fallback: Prefs = { source: 'chesscom', user: '', timeClass: 'rapid', count: 30 }
  try {
    const saved = localStorage.getItem(PREFS_KEY)
    if (saved) return { ...fallback, ...JSON.parse(saved) }
    const imp = localStorage.getItem(IMPORT_KEY) // reuse the username from "My games"
    if (imp) return { ...fallback, ...JSON.parse(imp) }
  } catch {
    /* storage unavailable */
  }
  return fallback
}

async function reportFor(p: Prefs): Promise<PatternReport | null> {
  if (!p.user.trim()) return null
  const games = (await storedGamesFor(p.user.trim(), p.source))
    .filter((g) => p.timeClass === 'all' || g.timeClass === p.timeClass)
    .sort((a, b) => b.date - a.date)
    .slice(0, p.count)
  return games.length ? buildReport(p.user.trim(), games) : null
}

export function PatternsView({ onOpen }: Props) {
  const [prefs, setPrefs] = useState(loadPrefs)
  const [progress, setProgress] = useState<BatchProgress | null>(null)
  const [report, setReport] = useState<PatternReport | null>(null)
  const batch = useRef<{ cancel: () => void } | null>(null)
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const refresh = useCallback((p: Prefs) => {
    void reportFor(p).then(setReport)
  }, [])

  // Show what's already cached for the saved player right away.
  useEffect(() => {
    const p = loadPrefs()
    void reportFor(p).then(setReport)
  }, [])

  useEffect(() => () => batch.current?.cancel(), [])

  const start = (e: React.FormEvent) => {
    e.preventDefault()
    const p = { ...prefs, user: prefs.user.trim() }
    if (!p.user) return
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(p))
    } catch {
      /* storage unavailable */
    }
    batch.current?.cancel()
    refresh(p)
    const run = runBatch(
      { source: p.source, user: p.user, timeClass: p.timeClass === 'all' ? undefined : p.timeClass, count: p.count },
      setProgress,
      () => {
        // Rebuilding the report re-reads every game; do it at most every couple of seconds.
        if (refreshTimer.current) return
        refreshTimer.current = setTimeout(() => {
          refreshTimer.current = null
          refresh(p)
        }, 2000)
      },
    )
    batch.current = run
    void run.done.then(() => refresh(p))
  }

  const open = async (key: string, ply: number) => {
    const g = await getStoredGame(key)
    if (!g) return
    onOpen(g, ply, g.white.toLowerCase() === prefs.user.trim().toLowerCase() ? 'w' : 'b')
  }

  const running = progress?.status === 'fetching' || progress?.status === 'reviewing'
  const toReview = progress ? progress.total - progress.cached : 0

  return (
    <div className="patterns">
      <div className="card">
        <h2>My patterns</h2>
        <p className="muted">
          Reviews your recent games and looks for mistakes you keep making. Each game is analyzed once and kept in this
          browser.
        </p>
        <form className="patterns-form" onSubmit={start}>
          <select value={prefs.source} onChange={(e) => setPrefs({ ...prefs, source: e.target.value as Source })}>
            <option value="chesscom">Chess.com</option>
            <option value="lichess">Lichess</option>
          </select>
          <input
            placeholder="Username"
            value={prefs.user}
            onChange={(e) => setPrefs({ ...prefs, user: e.target.value })}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
          <select value={prefs.timeClass} onChange={(e) => setPrefs({ ...prefs, timeClass: e.target.value as Prefs['timeClass'] })}>
            {CLASSES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
          <select value={prefs.count} onChange={(e) => setPrefs({ ...prefs, count: Number(e.target.value) })}>
            {COUNTS.map((n) => (
              <option key={n} value={n}>
                Last {n}
              </option>
            ))}
          </select>
          {running ? (
            <button type="button" onClick={() => batch.current?.cancel()}>
              Stop
            </button>
          ) : (
            <button type="submit" className="primary">
              Analyze my games
            </button>
          )}
        </form>

        {progress && <BatchStatus progress={progress} toReview={toReview} />}
      </div>

      {report ? <Report report={report} onOpen={open} /> : !running && <p className="muted center">No reviewed games for this player yet.</p>}
    </div>
  )
}

function BatchStatus({ progress: p, toReview }: { progress: BatchProgress; toReview: number }) {
  if (p.status === 'error') return <p className="error">{p.error}</p>
  if (p.status === 'fetching') return <p className="muted">Fetching games…</p>
  if (p.status === 'cancelled') return <p className="muted">Stopped. Games reviewed so far are kept.</p>
  const perGame = p.done ? p.elapsedMs / p.done : null
  const left = perGame && toReview > p.done ? Math.round(((toReview - p.done) * perGame) / 1000) : null
  return (
    <div className="batch-status">
      <div className="muted">
        {p.status === 'done'
          ? `Done: ${p.total} games (${p.done} newly reviewed, ${p.cached} from earlier).`
          : `Reviewing ${p.done}/${toReview} new games with ${p.engines} engine${p.engines > 1 ? 's' : ''}${p.cached ? ` · ${p.cached} already reviewed` : ''}${
              left !== null ? ` · about ${left < 90 ? `${left} s` : `${Math.round(left / 60)} min`} left` : ''
            }`}
      </div>
      {p.status === 'reviewing' && (
        <div className="bar">
          <div style={{ width: `${toReview ? (p.done / toReview) * 100 : 100}%` }} />
        </div>
      )}
    </div>
  )
}

function Report({ report: r, onOpen }: { report: PatternReport; onOpen: (key: string, ply: number) => void }) {
  const problems = r.insights.filter((i) => i.kind === 'problem')
  const others = r.insights.filter((i) => i.kind !== 'problem')
  const pct = (x: number) => `${Math.round(x * 100)}%`
  return (
    <>
      <div className="card report-head">
        <div>
          <div className="big">{r.games}</div>
          <div className="muted">games</div>
        </div>
        <div>
          <div className="big">
            {r.record.w}/{r.record.d}/{r.record.l}
          </div>
          <div className="muted">won/drawn/lost</div>
        </div>
        <div>
          <div className="big">{r.accuracy.toFixed(0)}%</div>
          <div className="muted">avg accuracy</div>
        </div>
        <div>
          <div className="big">~{r.playedLike}</div>
          <div className="muted">plays like</div>
        </div>
      </div>

      {problems.length === 0 && <p className="muted center">No recurring problems found in these games. Nice!</p>}
      {problems.map((i) => (
        <InsightCard key={i.id} insight={i} onOpen={onOpen} />
      ))}
      {others.map((i) => (
        <InsightCard key={i.id} insight={i} onOpen={onOpen} />
      ))}

      {r.tactics.length > 0 && (
        <div className="card">
          <h3>Tactics</h3>
          <p className="muted small">
            What your opponents' best reply did after your mistakes, and what you could have played when they erred.
          </p>
          <table className="data-table">
            <thead>
              <tr>
                <th />
                <th>Used against you</th>
                <th>You missed</th>
              </tr>
            </thead>
            <tbody>
              {r.tactics.map((t) => (
                <tr key={t.motif}>
                  <td className="cap">{MOTIF_NAME[t.motif]}</td>
                  <td>{t.against || '–'}</td>
                  <td>{t.missed || '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card">
        <h3>By phase</h3>
        <p className="muted small">Only positions that were still undecided, so won or lost endgames don't skew it.</p>
        <table className="data-table">
          <thead>
            <tr>
              <th />
              <th>Your moves</th>
              <th>Mistakes /100</th>
              <th>Accuracy</th>
            </tr>
          </thead>
          <tbody>
            {r.phases.map((p) => (
              <tr key={p.phase}>
                <td className="cap">{p.phase}</td>
                <td>{p.moves}</td>
                <td>{p.errorsPer100.toFixed(1)}</td>
                <td>{p.accuracy.toFixed(0)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h3>Openings</h3>
        <table className="data-table">
          <thead>
            <tr>
              <th />
              <th>Games</th>
              <th>Score</th>
              <th>Accuracy</th>
            </tr>
          </thead>
          <tbody>
            {r.openings.slice(0, 10).map((o) => (
              <tr key={`${o.name}|${o.color}`}>
                <td>
                  <span className={`swatch ${o.color}`} /> {o.name}
                </td>
                <td>{o.games}</td>
                <td>{pct(o.score)}</td>
                <td>{o.accuracy.toFixed(0)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h3>By colour</h3>
        <table className="data-table">
          <tbody>
            {(['w', 'b'] as const).map((c) => (
              <tr key={c}>
                <td>
                  <span className={`swatch ${c}`} /> {c === 'w' ? 'White' : 'Black'}
                </td>
                <td>{r.colors[c].games} games</td>
                <td>{pct(r.colors[c].score)} score</td>
                <td>{r.colors[c].accuracy.toFixed(0)}% accuracy</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

function InsightCard({ insight: i, onOpen }: { insight: Insight; onOpen: (key: string, ply: number) => void }) {
  return (
    <div className={`card insight ${i.kind}`}>
      <h3>
        {i.title}
        {i.tentative && (
          <span className="tentative" title="Based on little data; analyze more games to confirm">
            tentative
          </span>
        )}
      </h3>
      <p>{i.body}</p>
      <div className="evidence muted">Based on {i.evidence}</div>
      {i.examples.length > 0 && (
        <ul className="examples">
          {i.examples.map((e) => (
            <li key={`${e.key}:${e.ply}`}>
              <button onClick={() => onOpen(e.key, e.ply)}>
                <strong>{e.title}</strong>
                <span className="muted">{e.text}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
