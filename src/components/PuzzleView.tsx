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
import { MiniBoard } from './MiniBoard'
import { MOTIF_NAME, type Motif } from '../tactics'
import { DAILY_GOAL, loadPuzzleStats, recordPuzzle } from '../puzzleStats'

interface Props {
  onOpenGame: (gameKey: string, ply: number, me: 'w' | 'b') => void
  onGoToPatterns: () => void
}

type Phase = 'solving' | 'checking' | 'wrong' | 'solved' | 'revealed'
type Status = 'new' | 'due' | 'solved' | 'mastered'
const MASTERED_BOX = 3 // repetition box from which a puzzle counts as mastered
const BOXES = 5

const PREFS_KEY = 'chess-analyzer:patterns' // same player as My patterns
const ACCEPT_LOSS = 4 // a different move is accepted if it gives up at most this much win%

interface Filter {
  kind: 'all' | Puzzle['kind']
  status: 'all' | Status
  motif: 'all' | Motif
}

const motifOf = (p: Puzzle) => p.theme?.motif ?? p.allowed?.motif ?? null

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
  const [tab, setTab] = useState<'train' | 'list'>('train')
  const [game, setGame] = useState(loadPuzzleStats) // daily goal, day streak, best combo
  const [combo, setCombo] = useState(0) // correct answers in a row this session
  const [filter, setFilter] = useState<Filter>({ kind: 'all', status: 'all', motif: 'all' })
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
    const nextCombo = correct ? combo + 1 : 0
    setCombo(nextCombo)
    setGame((g) => recordPuzzle(g, correct, nextCombo))
  }

  /** Move on to the next puzzle; skipping an unsolved one doesn't count against you. */
  const next = useCallback(() => {
    if (!puzzles || !current) return
    const nextSkip = new Set(skip).add(current.id)
    setSkip(nextSkip)
    start(nextPuzzle(puzzles, progress, nextSkip))
  }, [puzzles, current, skip, progress, start])

  const play = (p: Puzzle) => {
    start(p)
    setTab('train')
    window.scrollTo(0, 0)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (tab !== 'train' || e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return
      if (e.key === 'ArrowRight') {
        e.preventDefault()
        next()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [tab, next])

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
    const mastered = puzzles.filter((p) => (progress.get(p.id)?.box ?? 0) >= MASTERED_BOX).length
    return { total: puzzles.length, due, fresh, mastered }
  }, [puzzles, progress, clock])

  const statusOf = useCallback(
    (p: Puzzle): Status => {
      const pr = progress.get(p.id)
      if (!pr) return 'new'
      if (pr.box >= MASTERED_BOX) return 'mastered'
      return pr.due <= clock ? 'due' : 'solved'
    },
    [progress, clock],
  )
  const motifs = useMemo(() => [...new Set((puzzles ?? []).map(motifOf).filter((m): m is Motif => !!m))], [puzzles])
  const listed = useMemo(
    () =>
      (puzzles ?? [])
        .filter((p) => filter.kind === 'all' || p.kind === filter.kind)
        .filter((p) => filter.status === 'all' || statusOf(p) === filter.status)
        .filter((p) => filter.motif === 'all' || motifOf(p) === filter.motif)
        .sort((a, b) => b.date - a.date || a.ply - b.ply),
    [puzzles, filter, statusOf],
  )

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

  const goalPct = Math.min(100, (game.today / DAILY_GOAL) * 100)

  return (
    <div className="puzzles">
      <div className="puzzle-top">
        <div className="tabs puzzle-tabs">
          <button className={tab === 'train' ? 'on' : ''} onClick={() => setTab('train')}>
            Train
          </button>
          <button className={tab === 'list' ? 'on' : ''} onClick={() => setTab('list')}>
            All puzzles ({puzzles.length})
          </button>
        </div>
        <div className="gamebar">
          <div className="goal" title={`Daily goal: ${DAILY_GOAL} puzzles solved`}>
            <div className="goal-label">{game.today >= DAILY_GOAL ? '🎯 Daily goal done!' : `Today ${game.today}/${DAILY_GOAL}`}</div>
            <div className="goal-bar">
              <div style={{ width: `${goalPct}%` }} />
            </div>
          </div>
          <div className="chip" title="Days in a row with at least one solved puzzle">
            📅 {game.streak} day{game.streak === 1 ? '' : 's'}
          </div>
          {combo >= 2 && <div className="chip hot">🔥 {combo} in a row</div>}
        </div>
        {stats && (
          <div className="puzzle-stats muted">
            {stats.due} due · {stats.fresh} new · {stats.mastered} mastered
            {session.tried > 0 && ` · this session ${session.solved}/${session.tried}`}
            {game.bestCombo >= 3 && ` · best run ${game.bestCombo}`}
          </div>
        )}
      </div>

      {tab === 'list' ? (
        <PuzzleList
          puzzles={listed}
          motifs={motifs}
          filter={filter}
          setFilter={setFilter}
          statusOf={statusOf}
          boxOf={(p) => progress.get(p.id)?.box ?? -1}
          onPlay={play}
        />
      ) : !current ? (
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
              {done && current.why.length > 0 && (
                <div className="puzzle-why">
                  <div className="puzzle-kind">Why it works</div>
                  {current.why.map((w, k) => (
                    <p key={k}>{w}</p>
                  ))}
                </div>
              )}
              {done && (
                <p className="muted small">
                  Line: {formatLine(current.fen, current.line, 8)}
                  {` · In the game you played ${current.playedSan}.`}
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
                    <button onClick={next} disabled={phase === 'checking'} title="Skip (→)">
                      Skip ›
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

interface ListProps {
  puzzles: Puzzle[]
  motifs: Motif[]
  filter: Filter
  setFilter: (f: Filter) => void
  statusOf: (p: Puzzle) => Status
  boxOf: (p: Puzzle) => number
  onPlay: (p: Puzzle) => void
}

const STATUS_LABEL: Record<Status, string> = { new: 'New', due: 'Due', solved: 'Solved', mastered: 'Mastered' }

function PuzzleList({ puzzles, motifs, filter, setFilter, statusOf, boxOf, onPlay }: ListProps) {
  return (
    <div className="puzzle-list-wrap">
      <div className="puzzle-filters">
        <select value={filter.kind} onChange={(e) => setFilter({ ...filter, kind: e.target.value as Filter['kind'] })}>
          <option value="all">All types</option>
          <option value="punish">Punish the mistake</option>
          <option value="better">Find a better move</option>
        </select>
        <select value={filter.motif} onChange={(e) => setFilter({ ...filter, motif: e.target.value as Filter['motif'] })}>
          <option value="all">All tactics</option>
          {motifs.map((m) => (
            <option key={m} value={m}>
              {MOTIF_NAME[m]}
            </option>
          ))}
        </select>
        <select value={filter.status} onChange={(e) => setFilter({ ...filter, status: e.target.value as Filter['status'] })}>
          <option value="all">Any status</option>
          {(Object.keys(STATUS_LABEL) as Status[]).map((st) => (
            <option key={st} value={st}>
              {STATUS_LABEL[st]}
            </option>
          ))}
        </select>
      </div>
      {puzzles.length === 0 && <p className="muted center">No puzzles match these filters.</p>}
      <ul className="puzzle-list">
        {puzzles.map((p) => {
          const st = statusOf(p)
          const box = boxOf(p)
          const motif = motifOf(p)
          return (
            <li key={p.id}>
              <button onClick={() => onPlay(p)}>
                <MiniBoard fen={p.fen} orientation={p.color} />
                <span className="pl-text">
                  <strong>{p.title}</strong>
                  <span className="muted">{p.kind === 'punish' ? 'Punish the mistake' : 'Find a better move'}</span>
                  {motif && <span className="pl-motif">{p.theme ? MOTIF_NAME[motif] : `avoid a ${MOTIF_NAME[motif]}`}</span>}
                  <span className="pl-status">
                    <span className={`st st-${st}`}>{STATUS_LABEL[st]}</span>
                    <span className="dots" title="Mastery">
                      {Array.from({ length: BOXES }, (_, i) => (i <= box ? '●' : '○')).join('')}
                    </span>
                  </span>
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
