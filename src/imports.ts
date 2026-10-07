// Fetch recent games from Lichess and Chess.com public APIs (both allow CORS, no auth).

export type Source = 'lichess' | 'chesscom'

/** Time classes, named the same for both sites (Lichess "correspondence" is "daily" here). */
export type TimeClass = 'bullet' | 'blitz' | 'rapid' | 'classical' | 'daily'

export interface GameSummary {
  id: string
  source: Source
  white: string
  black: string
  whiteElo?: number
  blackElo?: number
  result: string
  timeControl?: string // display label, e.g. "blitz"
  timeClass?: TimeClass
  date: number // epoch ms
  pgn: string
}

export interface FetchOptions {
  max?: number
  timeClass?: TimeClass // only games of this time class
}

const LICHESS_PERF: Record<TimeClass, string> = {
  bullet: 'bullet',
  blitz: 'blitz',
  rapid: 'rapid',
  classical: 'classical',
  daily: 'correspondence',
}

function lichessTimeClass(speed: string): TimeClass | undefined {
  if (speed === 'ultraBullet' || speed === 'bullet') return 'bullet'
  if (speed === 'correspondence') return 'daily'
  if (speed === 'blitz' || speed === 'rapid' || speed === 'classical') return speed
  return undefined
}

export async function fetchLichessGames(user: string, { max = 20, timeClass }: FetchOptions = {}): Promise<GameSummary[]> {
  const params = new URLSearchParams({
    max: String(max),
    pgnInJson: 'true',
    opening: 'true',
    clocks: 'true', // clock times in the PGN, for spotting time-trouble mistakes
    evals: 'false',
  })
  if (timeClass) params.set('perfType', LICHESS_PERF[timeClass])
  const res = await fetch(`https://lichess.org/api/games/user/${encodeURIComponent(user)}?${params}`, {
    headers: { Accept: 'application/x-ndjson' },
  })
  if (res.status === 404) {
    // The export endpoint also 404s when it's unavailable, so check whether the user exists.
    const exists = (await fetch(`https://lichess.org/api/user/${encodeURIComponent(user)}`)).ok
    throw new Error(exists ? 'Lichess game export is unavailable right now (404)' : `Lichess user "${user}" not found`)
  }
  if (!res.ok) throw new Error(`Lichess returned ${res.status}`)
  const text = await res.text()
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((g) => g.variant === 'standard' || g.variant === 'fromPosition')
    .map((g) => ({
      id: g.id,
      source: 'lichess' as const,
      white: g.players.white.user?.name ?? (g.players.white.aiLevel ? `Stockfish lvl ${g.players.white.aiLevel}` : 'Anonymous'),
      black: g.players.black.user?.name ?? (g.players.black.aiLevel ? `Stockfish lvl ${g.players.black.aiLevel}` : 'Anonymous'),
      whiteElo: g.players.white.rating,
      blackElo: g.players.black.rating,
      result: g.winner === 'white' ? '1-0' : g.winner === 'black' ? '0-1' : g.status === 'started' ? '*' : '½-½',
      timeControl: g.speed,
      timeClass: lichessTimeClass(g.speed),
      date: g.createdAt,
      pgn: g.pgn,
    }))
}

export async function fetchChessComGames(user: string, { max = 20, timeClass }: FetchOptions = {}): Promise<GameSummary[]> {
  const name = encodeURIComponent(user.toLowerCase())
  const archivesRes = await fetch(`https://api.chess.com/pub/player/${name}/games/archives`)
  if (archivesRes.status === 404) throw new Error(`Chess.com user "${user}" not found`)
  if (!archivesRes.ok) throw new Error(`Chess.com returned ${archivesRes.status}`)
  const { archives } = (await archivesRes.json()) as { archives: string[] }

  const games: GameSummary[] = []
  // Walk monthly archives newest-first until we have enough games.
  for (const archive of [...archives].reverse()) {
    const res = await fetch(archive)
    if (!res.ok) break
    const data = await res.json()
    const month = (data.games as any[])
      .filter((g) => g.rules === 'chess' && g.pgn && (!timeClass || g.time_class === timeClass))
      .map((g) => ({
        id: g.uuid ?? g.url,
        source: 'chesscom' as const,
        white: g.white.username,
        black: g.black.username,
        whiteElo: g.white.rating,
        blackElo: g.black.rating,
        result: g.white.result === 'win' ? '1-0' : g.black.result === 'win' ? '0-1' : '½-½',
        timeControl: g.time_class,
        timeClass: g.time_class as TimeClass,
        date: g.end_time * 1000,
        pgn: g.pgn,
      }))
      .reverse()
    games.push(...month)
    if (games.length >= max) break
  }
  return games.slice(0, max)
}

export function fetchGames(source: Source, user: string, options?: FetchOptions) {
  return source === 'lichess' ? fetchLichessGames(user, options) : fetchChessComGames(user, options)
}
