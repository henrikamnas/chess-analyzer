import { useState } from 'react'
import { fetchChessComGames, fetchLichessGames, type GameSummary } from '../imports'

interface Props {
  onLoad: (pgn: string) => void
}

const SAMPLE = `[Event "Opera Game"]
[White "Paul Morphy"]
[Black "Duke Karl / Count Isouard"]
[Result "1-0"]
[Date "1858.??.??"]

1. e4 e5 2. Nf3 d6 3. d4 Bg4 4. dxe5 Bxf3 5. Qxf3 dxe5 6. Bc4 Nf6 7. Qb3 Qe7
8. Nc3 c6 9. Bg5 b5 10. Nxb5 cxb5 11. Bxb5+ Nbd7 12. O-O-O Rd8 13. Rxd7 Rxd7
14. Rd1 Qe6 15. Bxd7+ Nxd7 16. Qb8+ Nxb8 17. Rd8# 1-0`

const STORE_KEY = 'chess-analyzer:import'
type Source = 'lichess' | 'chesscom'

function loadPrefs(): { source: Source; user: string } {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (raw) return JSON.parse(raw)
  } catch {
    /* storage unavailable */
  }
  return { source: 'lichess', user: '' }
}

export function ImportPanel({ onLoad }: Props) {
  const [tab, setTab] = useState<'user' | 'pgn'>('user')
  const [prefs, setPrefs] = useState(loadPrefs)
  const [pgn, setPgn] = useState('')
  const [games, setGames] = useState<GameSummary[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetchGames = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!prefs.user.trim()) return
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(prefs))
    } catch {
      /* storage unavailable */
    }
    setLoading(true)
    setError(null)
    try {
      const fetcher = prefs.source === 'lichess' ? fetchLichessGames : fetchChessComGames
      setGames(await fetcher(prefs.user.trim()))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setGames(null)
    } finally {
      setLoading(false)
    }
  }

  const me = prefs.user.trim().toLowerCase()

  return (
    <div className="import-panel">
      <div className="tabs">
        <button className={tab === 'user' ? 'on' : ''} onClick={() => setTab('user')}>My games</button>
        <button className={tab === 'pgn' ? 'on' : ''} onClick={() => setTab('pgn')}>Paste PGN</button>
      </div>

      {tab === 'user' ? (
        <>
          <form className="user-form" onSubmit={fetchGames}>
            <select value={prefs.source} onChange={(e) => setPrefs({ ...prefs, source: e.target.value as Source })}>
              <option value="lichess">Lichess</option>
              <option value="chesscom">Chess.com</option>
            </select>
            <input
              placeholder="Username"
              value={prefs.user}
              onChange={(e) => setPrefs({ ...prefs, user: e.target.value })}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
            <button type="submit" className="primary" disabled={loading}>{loading ? '…' : 'Fetch'}</button>
          </form>
          {error && <p className="error">{error}</p>}
          {games && games.length === 0 && <p className="muted">No games found.</p>}
          {games && games.length > 0 && (
            <ul className="game-list">
              {games.map((g) => {
                const myColor = g.white.toLowerCase() === me ? 'w' : g.black.toLowerCase() === me ? 'b' : null
                const outcome =
                  g.result === '½-½' || g.result === '*' || !myColor
                    ? 'draw'
                    : (g.result === '1-0') === (myColor === 'w')
                      ? 'win'
                      : 'loss'
                return (
                  <li key={g.id}>
                    <button onClick={() => onLoad(g.pgn)}>
                      <span className={`result-pill ${outcome}`}>{g.result}</span>
                      <span className="players">
                        <span>{g.white} {g.whiteElo && <small>{g.whiteElo}</small>}</span>
                        <span>{g.black} {g.blackElo && <small>{g.blackElo}</small>}</span>
                      </span>
                      <span className="meta">
                        <span>{g.timeControl}</span>
                        <span>{new Date(g.date).toLocaleDateString()}</span>
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
          {!games && !error && (
            <p className="muted">
              Enter your username to list recent games, or{' '}
              <button className="link" onClick={() => onLoad(SAMPLE)}>try a sample game</button>.
            </p>
          )}
        </>
      ) : (
        <div className="pgn-form">
          <textarea placeholder="Paste a PGN…" value={pgn} onChange={(e) => setPgn(e.target.value)} rows={8} spellCheck={false} />
          <div className="row">
            <button className="primary" disabled={!pgn.trim()} onClick={() => onLoad(pgn)}>Analyze</button>
            <button onClick={() => onLoad(SAMPLE)}>Try a sample game</button>
          </div>
        </div>
      )}
    </div>
  )
}
