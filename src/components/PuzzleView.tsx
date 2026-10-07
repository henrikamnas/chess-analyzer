import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Chess } from 'chess.js'
import type { DrawShape } from 'chessground/draw'
import type { Key } from 'chessground/types'
import { Board } from './Board'
import { Engine } from '../engine'
import { pvToSan } from '../analysis'
import { formatLine } from '../explain'
import { buildPuzzles, moverWin, nextPuzzle, puzzleHint, puzzlePrompt, schedule, type Puzzle } from '../puzzles'
import { allPuzzleProgress, putPuzzleProgress, storedGamesFor, type PuzzleProgress, type StoredGame } from '../store'
import type { Source } from '../imports'

interface Props {
  onOpenGame: (gameKey: string, ply: number, me: 'w' | 'b') => void
  onGoToPatterns: () => void
}

type Phase = 'solving' | 'checking' | 'wrong' | 'solved' | 'revealed'

const PREFS_KEY = 'chess-analyzer:patterns' // same player as My patterns
const ACCEPT_LOSS = 4 // a different move is accepted if it gives up at most this much win%

function playerPrefs(): { user: string; source: Source } | null {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? 'null')
    return p?.user ? { user: p.user, source: p.source } : null
  } catch {
    return null
  }
}

export function PuzzleView({ onOpenGame, onGoToPatterns }: Props) {
  const [player] = useState(playerPrefs)
  const [puzzles, setPuzzles] = useState<Puzzle[] | null>(null)
  const [progress, setProgress] = useState<Map<string, PuzzleProgress>>(new Map())
  const [skip, setSkip] = useState<Set<string>>(new Set()) // seen this session
  const [current, setCurrent] = useState<Puzzle | null>(null)
  const [phase, setPhase] = useState<Phase>('solving')
  const [fen, setFen] = useState<string>('')
  const [lastMove, setLastMove] = useState<string | undefined>()
  const [hint, setHint] = useState(0)
  const [missed, setMissed] = useState(false) // any wrong attempt or full reveal on this puzzle
  const [feedback, setFeedback] = useState<string | null>(null)
  const [replyArrow, setReplyArrow] = useState<string | null>(null)
  const [session, setSession] = useState({ solved: 0, tried: 0 })
  const [clock, setClock] = useState(() => Date.now()) // "now" for due counts, refreshed after each attempt
  const engine = useRef<Engine | null>(null)

  useEffect(() => {
    engine.current = new Engine()
    return () => engine.current?.terminate()
  }, [])

  const start = useCallback((p: Puzzle | null) => {
    setCurrent(p)
    setPhase('solving')
    setHint(0)
    setMissed(false)
    setFeedback(null)
    setReplyArrow(null)
    setLastMove(undefined)
    setFen(p?.fen ?? '')
  }, [])

  // Load puzzles from the player's reviewed games and their repetition state, then pick the first one
  useEffect(() => {
    if (!player) return
    void Promise.all([storedGamesFor(player.user, player.source), allPuzzleProgress()]).then(([games, prog]: [StoredGame[], PuzzleProgress[]]) => {
      const list = buildPuzzles(player.user, games)
      const map = new Map(prog.map((p) => [p.id, p]))
      setPuzzles(list)
      setProgress(map)
      start(nextPuzzle(list, map, new Set()))
    })
  }, [player, start])

  const finish = (correct: boolean) => {
    if (!current) return
    const p = schedule(progress.get(current.id), current.id, correct)
    void putPuzzleProgress(p)
    setProgress((m) => new Map(m).set(current.id, p))
    setSession((s) => ({ solved: s.solved + (correct ? 1 : 0), tried: s.tried + 1 }))
    setClock(Date.now())
  }

  const next = () => {
    if (!puzzles || !current) return
    const nextSkip = new Set(skip).add(current.id)
    setSkip(nextSkip)
    start(nextPuzzle(puzzles, progress, nextSkip))
  }

  const onMove = async (uci: string) => {
    if (!current || phase !== 'solving') return
    const chess = new Chess(current.fen)
    const move = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] })
    setFen(chess.fen())
    setLastMove(uci)
    const solved = (how: string) => {
      setPhase('solved')
      setFeedback(how)
      finish(!missed && hint < 2)
    }
    if (uci === current.best) return solved(`Correct! ${current.bestSan} is the best move.`)

    // A different move may be just as good: ask the engine.
    setPhase('checking')
    setFeedback('Checking your move…')
    const r = await engine.current!.analyze(chess.fen(), { depth: 14 })
    const loss = moverWin(current.score, current.color) - moverWin(r.score, current.color)
    if (chess.isCheckmate() || loss <= ACCEPT_LOSS) {
      return solved(`Good move! ${move.san} works too. The engine's top choice was ${current.bestSan}.`)
    }
    const reply = r.pv[0]
    const replySan = reply ? pvToSan(chess.fen(), [reply])[0] : null
    setMissed(true)
    setPhase('wrong')
    setReplyArrow(reply ?? null)
    setFeedback(`Not quite. After ${move.san}, your opponent can answer ${replySan ?? 'strongly'}. Try again.`)
    setTimeout(() => {
      setFen(current.fen)
      setLastMove(undefined)
      setReplyArrow(null)
      setPhase('solving')
    }, 1800)
  }

  const reveal = () => {
    if (!current) return
    setMissed(true)
    const chess = new Chess(current.fen)
    chess.move({ from: current.best.slice(0, 2), to: current.best.slice(2, 4), promotion: current.best[4] })
    setFen(chess.fen())
    setLastMove(current.best)
    setPhase('revealed')
    setFeedback(`The answer was ${current.bestSan}.`)
    finish(false)
  }

  const shapes = useMemo(() => {
    const out: DrawShape[] = []
    if (!current) return out
    if (phase === 'solving' && hint >= 2) out.push({ orig: current.best.slice(0, 2) as Key, brush: 'green' })
    if (replyArrow) out.push({ orig: replyArrow.slice(0, 2) as Key, dest: replyArrow.slice(2, 4) as Key, brush: 'red' })
    return out
  }, [current, phase, hint, replyArrow])

  const stats = useMemo(() => {
    if (!puzzles) return null
    const due = puzzles.filter((p) => progress.get(p.id) && progress.get(p.id)!.due <= clock).length
    const fresh = puzzles.filter((p) => !progress.has(p.id)).length
    const mastered = puzzles.filter((p) => (progress.get(p.id)?.box ?? 0) >= 3).length
    return { total: puzzles.length, due, fresh, mastered }
  }, [puzzles, progress, clock])

  if (!player) {
    return (
      <div className="puzzles">
        <div className="card">
          <h2>Puzzles</h2>
          <p>Puzzles are made from your own games. Analyze your games in My patterns first.</p>
          <button className="primary" onClick={onGoToPatterns}>
            Go to My patterns
          </button>
        </div>
      </div>
    )
  }
  if (!puzzles) return <div className="puzzles"><p className="muted center">Loading puzzles…</p></div>
  if (puzzles.length === 0) {
    return (
      <div className="puzzles">
        <div className="card">
          <h2>Puzzles</h2>
          <p>No puzzles yet for {player.user}. Analyze some games in My patterns, and your mistakes become puzzles here.</p>
          <button className="primary" onClick={onGoToPatterns}>
            Go to My patterns
          </button>
        </div>
      </div>
    )
  }

  const done = phase === 'solved' || phase === 'revealed'
  const orientation = current?.color === 'b' ? 'black' : 'white'

  return (
    <div className="puzzles">
      <div className="puzzle-stats muted">
        {stats && (
          <>
            {stats.total} puzzles from your games · {stats.due} due · {stats.fresh} new · {stats.mastered} mastered
            {session.tried > 0 && ` · this session ${session.solved}/${session.tried}`}
          </>
        )}
      </div>

      {!current ? (
        <div className="card center">
          <h2>All caught up</h2>
          <p className="muted">No puzzles are due right now. Analyze more games to get new ones, or come back later.</p>
          <button
            onClick={() => {
              setSkip(new Set())
              start(nextPuzzle(puzzles, progress, new Set(), Infinity))
            }}
          >
            Practice anyway
          </button>
        </div>
      ) : (
        <div className="puzzle-layout">
          <div className="puzzle-board">
            <div className={`puzzle-turn ${current.color}`}>{current.color === 'w' ? 'White' : 'Black'} to move · {current.title}</div>
            <Board fen={fen} orientation={orientation} lastMove={lastMove} shapes={shapes} onMove={onMove} interactive={phase === 'solving'} />
          </div>
          <div className="puzzle-side">
            <div className={`card puzzle-task ${current.kind}`}>
              <div className="puzzle-kind">{current.kind === 'punish' ? 'Punish the mistake' : 'Find a better move'}</div>
              <p>{puzzlePrompt(current)}</p>
              {hint >= 1 && !done && <p className="hint">💡 {puzzleHint(current)}</p>}
              {hint >= 2 && !done && <p className="hint">💡 The piece to move is highlighted.</p>}
              {feedback && <p className={`feedback ${phase}`}>{feedback}</p>}
              {done && (
                <p className="muted small">
                  Line: {formatLine(current.fen, current.line, 8)}
                  {current.kind === 'better' && ` · In the game you played ${current.playedSan}.`}
                </p>
              )}
              <div className="row">
                {!done ? (
                  <>
                    {hint < 2 && (
                      <button onClick={() => setHint((h) => h + 1)} disabled={phase === 'checking'}>
                        💡 Hint
                      </button>
                    )}
                    <button onClick={reveal} disabled={phase === 'checking'}>
                      Show solution
                    </button>
                  </>
                ) : (
                  <>
                    <button className="primary" onClick={next}>
                      Next puzzle
                    </button>
                    <button onClick={() => onOpenGame(current.gameKey, current.ply - 1, current.color)}>Open game</button>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
