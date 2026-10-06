// Fetch recent games from Lichess and Chess.com public APIs (both allow CORS, no auth).

export interface GameSummary {
  id: string
  source: 'lichess' | 'chesscom'
  white: string
  black: string
  whiteElo?: number
  blackElo?: number
  result: string
  timeControl?: string
  date: number // epoch ms
  pgn: string
}

export async function fetchLichessGames(user: string, max = 20): Promise<GameSummary[]> {
  const url = `https://lichess.org/api/games/user/${encodeURIComponent(user)}?max=${max}&pgnInJson=true&opening=true&clocks=false&evals=false`
  const res = await fetch(url, { headers: { Accept: 'application/x-ndjson' } })
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
      date: g.createdAt,
      pgn: g.pgn,
    }))
}

export async function fetchChessComGames(user: string, max = 20): Promise<GameSummary[]> {
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
      .filter((g) => g.rules === 'chess' && g.pgn)
      .map((g) => ({
        id: g.uuid ?? g.url,
        source: 'chesscom' as const,
        white: g.white.username,
        black: g.black.username,
        whiteElo: g.white.rating,
        blackElo: g.black.rating,
        result: g.white.result === 'win' ? '1-0' : g.black.result === 'win' ? '0-1' : '½-½',
        timeControl: g.time_class,
        date: g.end_time * 1000,
        pgn: g.pgn,
      }))
      .reverse()
    games.push(...month)
    if (games.length >= max) break
  }
  return games.slice(0, max)
}
