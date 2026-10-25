import { useEffect, useMemo, useState } from 'react'
import { t, useLang } from '../i18n'

interface FamousGame {
  id: string
  title: string
  white: string
  black: string
  whiteElo: number | null
  blackElo: number | null
  event: string
  site: string
  date: string
  year: number
  result: string
  eco: string
  opening: string
  players: string[] // the famous player(s) it's listed under
  about: string
  moves: string // SAN movetext
}

let famous: Promise<FamousGame[]> | null = null

function loadFamous(): Promise<FamousGame[]> {
  famous ??= fetch(`${import.meta.env.BASE_URL}famous/games.json`)
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      return r.json() as Promise<{ games: FamousGame[] }>
    })
    .then((d) => d.games)
  famous.catch(() => (famous = null))
  return famous
}

/** The game as a PGN, with its title as the event when it has a well-known name. */
function famousPgn(g: FamousGame): string {
  const tag = (k: string, v: string | number | null) => (v === null || v === '' ? '' : `[${k} "${String(v).replace(/"/g, "'")}"]\n`)
  return (
    tag('Event', g.event) +
    tag('Site', g.site) +
    tag('Date', g.date) +
    tag('White', g.white) +
    tag('Black', g.black) +
    tag('Result', g.result) +
    tag('WhiteElo', g.whiteElo) +
    tag('BlackElo', g.blackElo) +
    tag('ECO', g.eco) +
    tag('Opening', g.opening) +
    `\n${g.moves} ${g.result}`
  )
}

const surname = (name: string) => name.split(' ').at(-1)!

/** Famous games to step through, by player or searched by name, opening, event or year. */
export function FamousGames({ onLoad }: { onLoad: (pgn: string) => void }) {
  useLang()
  const [games, setGames] = useState<FamousGame[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [player, setPlayer] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  useEffect(() => {
    let live = true
    loadFamous().then(
      (g) => live && setGames(g),
      (e: Error) => live && setError(e.message),
    )
    return () => {
      live = false
    }
  }, [])

  // Players by surname, with how many games each has
  const players = useMemo(() => {
    const count = new Map<string, number>()
    for (const g of games ?? []) for (const p of g.players) count.set(p, (count.get(p) ?? 0) + 1)
    return [...count].sort((a, b) => surname(a[0]).localeCompare(surname(b[0])))
  }, [games])

  const shown = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    return (games ?? [])
      .filter((g) => !player || g.players.includes(player))
      .filter((g) => {
        const text = `${g.title} ${g.white} ${g.black} ${g.event} ${g.year} ${g.opening} ${g.eco}`.toLowerCase()
        return words.every((w) => text.includes(w))
      })
      .sort((a, b) => a.year - b.year)
  }, [games, player, query])

  if (error) return <p className="error">{t('Could not load the famous games: {error}', { error })}</p>
  if (!games) return <p className="muted">{t('Loading…')}</p>

  return (
    <div className="famous">
      <input
        type="search"
        placeholder={t('Search player, opening, event or year')}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        spellCheck={false}
      />
      <div className="famous-players" role="group" aria-label={t('Players')}>
        <button className={player === null ? 'on' : ''} onClick={() => setPlayer(null)}>
          {t('All')} <small>{games.length}</small>
        </button>
        {players.map(([name, n]) => (
          <button key={name} className={player === name ? 'on' : ''} onClick={() => setPlayer(player === name ? null : name)}>
            {name} <small>{n}</small>
          </button>
        ))}
      </div>
      {shown.length === 0 ? (
        <p className="muted">{t('No games found.')}</p>
      ) : (
        <ul className="game-list famous-list">
          {shown.map((g) => (
            <li key={g.id}>
              <button onClick={() => onLoad(famousPgn(g))}>
                <span className="famous-head">
                  <strong>{g.title}</strong>
                  <span className="muted">
                    {g.year} · {g.result}
                  </span>
                </span>
                <span className="famous-players-line">
                  {g.white} – {g.black}
                  {g.opening && <span className="muted"> · {g.opening}</span>}
                </span>
                <span className="famous-about muted">{g.about}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
