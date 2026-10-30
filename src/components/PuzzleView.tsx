import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Chess } from 'chess.js'
import type { DrawShape } from 'chessground/draw'
import type { Key } from 'chessground/types'
import { Board } from './Board'
import { Engine, type Score } from '../engine'
import { formatScore, pvToSan } from '../analysis'
import { formatLine } from '../explain'
import { buildPuzzles, moverWin, nextPuzzle, puzzleHint, puzzlePrompt, schedule, type Puzzle } from '../puzzles'
import { allPuzzleProgress, putPuzzleProgress, storedGamesFor, type PuzzleProgress, type StoredGame } from '../store'
import type { Source } from '../imports'
import { bookInfo, loadOpenings } from '../openings'
import { MiniBoard } from './MiniBoard'
import { describeTactic, motifName, type Motif } from '../tactics'
import { t, tn, useLang } from '../i18n'
import { DAILY_GOAL, loadPuzzleStats, recordPuzzle } from '../puzzleStats'

interface Props {
  onOpenGame: (gameKey: string, ply: number, me: 'w' | 'b') => void
  onGoToPatterns: () => void
}

// 'intro': the opponent's last move is being played on the board before the puzzle starts
type Phase = 'intro' | 'solving' | 'checking' | 'wrong' | 'solved' | 'revealed'
const INTRO_MS = 700
type Status = 'new' | 'due' | 'solved' | 'mastered'
const MASTERED_BOX = 3 // repetition box from which a puzzle counts as mastered
const BOXES = 5

const PLAY_ON_DEPTH = 12 // engine replies when playing on after a puzzle

/** The position after playing `moves` (UCI) from `fen`. */
function replay(fen: string, moves: string[]) {
  const chess = new Chess(fen)
  for (const m of moves) chess.move({ from: m.slice(0, 2), to: m.slice(2, 4), promotion: m[4] })
  return chess
}

const PREFS_KEY ='chess-analyzer:patterns' // same player as My patterns
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
  const [isReview, setIsReview] = useState(false) // the current puzzle was done before
  // Playing on after the puzzle: moves from the puzzle position (starting with the answer), the engine answering
  const [played, setPlayed] = useState<string[]>([])
  const [thinking, setThinking] = useState(false)
  const [suggest, setSuggest] = useState<string | null>(null) // engine's best move for you in the play-on position
  const [showSuggest, setShowSuggest] = useState(false)
  const [playEval, setPlayEval] = useState<Score | null>(null)
  const [session, setSession] = useState({ solved: 0, tried: 0 })
  const [clock, setClock] = useState(() => Date.now()) // "now" for due counts, refreshed after each attempt
  const [tab, setTab] = useState<'train' | 'list'>('train')
  const [game, setGame] = useState(loadPuzzleStats) // daily goal, day streak, best combo
  const [combo, setCombo] = useState(0) // correct answers in a row this session
  const [filter, setFilter] = useState<Filter>({ kind: 'all', status: 'all', motif: 'all' })
  const engine = useRef<Engine | null>(null)
  const introTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const puzzleToken = useRef(0) // bumped per puzzle so late engine answers for an old one are dropped
  const progressRef = useRef(progress) // for start(), which tells new puzzles from reviews
  useEffect(() => {
    progressRef.current = progress
  }, [progress])

  useEffect(() => {
    engine.current = new Engine()
    return () => {
      engine.current?.terminate()
      if (introTimer.current) clearTimeout(introTimer.current)
    }
  }, [])

  const start = useCallback((p: Puzzle | null) => {
    setCurrent(p)
    setHint(0)
    setMissed(false)
    setFeedback(null)
    setReplyArrow(null)
    setIsReview(!!p && progressRef.current.has(p.id))
    setPlayed([])
    setThinking(false)
    setSuggest(null)
    setShowSuggest(false)
    setPlayEval(null)
    puzzleToken.current++
    if (introTimer.current) clearTimeout(introTimer.current)
    // Show the position before the opponent's move, then play it, so you see what just happened.
    if (p?.prev) {
      setPhase('intro')
      setFen(p.prev.fenBefore)
      setLastMove(undefined)
      introTimer.current = setTimeout(() => {
        setFen(p.fen)
        setLastMove(p.prev!.uci)
        setPhase('solving')
      }, INTRO_MS)
    } else {
      setPhase('solving')
      setFen(p?.fen ?? '')
      setLastMove(undefined)
    }
  }, [])

  // Load puzzles from the player's reviewed games and their repetition state, then pick the first one.
  // Also rebuilt when the language changes (hints and explanations are generated text); the open puzzle stays.
  const lang = useLang()
  const currentId = useRef<string | null>(null)
  useEffect(() => {
    currentId.current = current?.id ?? null
  }, [current])
  useEffect(() => {
    if (!player) return
    void Promise.all([storedGamesFor(player.user, player.source), allPuzzleProgress(), loadOpenings()]).then(([games, prog, db]) => {
      const list = buildPuzzles(player.user, games as StoredGame[], (g) => bookInfo(g, db).bookPlies)
      const map = new Map((prog as PuzzleProgress[]).map((p) => [p.id, p]))
      setPuzzles(list)
      setProgress(map)
      progressRef.current = map
      const same = currentId.current ? list.find((p) => p.id === currentId.current) : undefined
      if (same) setCurrent(same)
      else start(nextPuzzle(list, map, new Set()))
    })
  }, [player, start, lang])

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

  /** After the answer (or a move of yours while playing on), let the opponent reply: the stored engine line while
   *  you follow it, otherwise a fresh engine search. */
  const answer = async (moves: string[]) => {
    if (!current) return
    const token = puzzleToken.current
    const chess = replay(current.fen, moves)
    setPlayed(moves)
    setFen(chess.fen())
    setLastMove(moves[moves.length - 1])
    setShowSuggest(false)
    setSuggest(null)
    if (chess.isGameOver()) return
    setThinking(true)
    let reply: string | undefined
    let after: string | null = null
    if (moves.every((m, i) => current.line[i] === m) && current.line[moves.length]) {
      await new Promise((r) => setTimeout(r, 500))
      reply = current.line[moves.length]
      after = current.line[moves.length + 1] ?? null
      setPlayEval(current.score)
    } else {
      const r = await engine.current!.analyze(chess.fen(), { depth: PLAY_ON_DEPTH })
      reply = r.pv[0]
      after = r.pv[1] ?? null
      if (token === puzzleToken.current) setPlayEval(r.score)
    }
    if (token !== puzzleToken.current) return
    setThinking(false)
    if (!reply) return
    const next = [...moves, reply]
    setPlayed(next)
    setFen(replay(current.fen, next).fen())
    setLastMove(reply)
    setSuggest(after)
  }

  /** Take back your last play-on move and the reply to it. */
  const undo = () => {
    if (!current || played.length < 4) return
    const back = played.slice(0, -2)
    setPlayed(back)
    setFen(replay(current.fen, back).fen())
    setLastMove(back[back.length - 1])
    setSuggest(null)
    setShowSuggest(false)
    setPlayEval(null)
  }

  const onMove = async (uci: string) => {
    if (!current) return
    if (phase === 'solved' || phase === 'revealed') {
      if (!thinking) void answer([...played, uci])
      return
    }
    if (phase !== 'solving') return
    const token = puzzleToken.current
    const chess = new Chess(current.fen)
    const move = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] })
    setFen(chess.fen())
    setLastMove(uci)
    const solved = (how: string) => {
      setPhase('solved')
      setFeedback(how)
      finish(!missed && hint < 2)
      void answer([uci])
    }
    if (uci === current.best) return solved(t('Correct! {move} is the best move.', { move: current.bestSan }))

    // A different move may be just as good: ask the engine.
    setPhase('checking')
    setFeedback(t('Checking your move…'))
    const r = await engine.current!.analyze(chess.fen(), { depth: 14 })
    if (token !== puzzleToken.current) return
    const loss = moverWin(current.score, current.color) - moverWin(r.score, current.color)
    if (chess.isCheckmate() || loss <= ACCEPT_LOSS) {
      return solved(t("Good move! {move} works too. The engine's top choice was {best}.", { move: move.san, best: current.bestSan }))
    }
    const reply = r.pv[0]
    const replySan = reply ? pvToSan(chess.fen(), [reply])[0] : null
    setMissed(true)
    setPhase('wrong')
    setReplyArrow(reply ?? null)
    setFeedback(t('Not quite. After {move}, your opponent can answer {reply}. Try again.', { move: move.san, reply: replySan ?? t('strongly') }))
    setTimeout(() => {
      if (token !== puzzleToken.current) return
      setFen(current.fen)
      setLastMove(current.prev?.uci)
      setReplyArrow(null)
      setPhase('solving')
    }, 1800)
  }

  const reveal = () => {
    if (!current) return
    setMissed(true)
    setPhase('revealed')
    setFeedback(t('The answer was {move}.', { move: current.bestSan }))
    finish(false)
    void answer([current.best])
  }

  const shapes = useMemo(() => {
    const out: DrawShape[] = []
    if (!current) return out
    if (phase === 'solving' && hint >= 2) out.push({ orig: current.best.slice(0, 2) as Key, brush: 'green' })
    if (replyArrow) out.push({ orig: replyArrow.slice(0, 2) as Key, dest: replyArrow.slice(2, 4) as Key, brush: 'red' })
    if (showSuggest && suggest) out.push({ orig: suggest.slice(0, 2) as Key, dest: suggest.slice(2, 4) as Key, brush: 'green' })
    return out
  }, [current, phase, hint, replyArrow, showSuggest, suggest])

  const stats = useMemo(() => {
    if (!puzzles) return null
    const due = puzzles.filter((p) => progress.get(p.id) && progress.get(p.id)!.due <= clock).length
    const fresh = puzzles.filter((p) => !progress.has(p.id)).length
    const mastered = puzzles.filter((p) => (progress.get(p.id)?.box ?? 0) >= MASTERED_BOX).length
    return { total: puzzles.length, due, fresh, mastered }
  }, [puzzles, progress, clock])

  // Puzzles "Next puzzle" can still serve after this one: new ones and due reviews not yet seen this session
  const left = useMemo(
    () =>
      (puzzles ?? []).filter((p) => p.id !== current?.id && !skip.has(p.id) && (!progress.has(p.id) || progress.get(p.id)!.due <= clock)).length,
    [puzzles, current, skip, progress, clock],
  )

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
          <h2>{t('Puzzles')}</h2>
          <p>{t('Puzzles are made from your own games. Analyze your games in My patterns first.')}</p>
          <button className="primary" onClick={onGoToPatterns}>
            {t('Go to My patterns')}
          </button>
        </div>
      </div>
    )
  }
  if (!puzzles) return <div className="puzzles"><p className="muted center">{t('Loading puzzles…')}</p></div>
  if (puzzles.length === 0) {
    return (
      <div className="puzzles">
        <div className="card">
          <h2>{t('Puzzles')}</h2>
          <p>{t('No puzzles yet for {user}. Analyze some games in My patterns, and your mistakes become puzzles here.', { user: player.user })}</p>
          <button className="primary" onClick={onGoToPatterns}>
            {t('Go to My patterns')}
          </button>
        </div>
      </div>
    )
  }

  const done = phase === 'solved' || phase === 'revealed'
  const playOn = done && current && played.length > 0 ? replay(current.fen, played) : null
  const myTurn = !!playOn && !thinking && !playOn.isGameOver() && playOn.turn() === current?.color
  const orientation = current?.color === 'b' ? 'black' : 'white'

  const goalPct = Math.min(100, (game.today / DAILY_GOAL) * 100)

  return (
    <div className="puzzles">
      <div className="puzzle-top">
        <div className="tabs puzzle-tabs">
          <button className={tab === 'train' ? 'on' : ''} onClick={() => setTab('train')}>
            {t('Train')}
          </button>
          <button className={tab === 'list' ? 'on' : ''} onClick={() => setTab('list')}>
            {t('All puzzles ({n})', { n: puzzles.length })}
          </button>
        </div>
        <div className="gamebar">
          <div className="goal" title={t('Daily goal: {n} puzzles solved', { n: DAILY_GOAL })}>
            <div className="goal-label">{game.today >= DAILY_GOAL ? t('🎯 Daily goal done!') : t('Today {n}/{goal}', { n: game.today, goal: DAILY_GOAL })}</div>
            <div className="goal-bar">
              <div style={{ width: `${goalPct}%` }} />
            </div>
          </div>
          <div className="chip" title={t('Days in a row with at least one solved puzzle')}>
            📅 {tn('{n} day', '{n} days', game.streak)}
          </div>
          {combo >= 2 && <div className="chip hot">🔥 {t('{n} in a row', { n: combo })}</div>}
        </div>
        {stats && (
          <div className="puzzle-stats muted">
            {t('{due} due · {fresh} new · {mastered} mastered', { due: stats.due, fresh: stats.fresh, mastered: stats.mastered })}
            {session.tried > 0 && t(' · this session {solved}/{tried}', { solved: session.solved, tried: session.tried })}
            {game.bestCombo >= 3 && t(' · best run {n}', { n: game.bestCombo })}
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
          <h2>{t('All caught up')}</h2>
          <p className="muted">{t('No puzzles are due right now. Analyze more games to get new ones, or come back later.')}</p>
          <button
            onClick={() => {
              setSkip(new Set())
              start(nextPuzzle(puzzles, progress, new Set(), Infinity))
            }}
          >
            {t('Practice anyway')}
          </button>
        </div>
      ) : (
        <div className="puzzle-layout">
          <div className="puzzle-board">
            <div className={`puzzle-turn ${current.color}`}>{t(current.color === 'w' ? 'White to move' : 'Black to move')} · {current.title}</div>
            <Board fen={fen} orientation={orientation} lastMove={lastMove} shapes={shapes} onMove={onMove} interactive={phase === 'solving' || myTurn} />
          </div>
          <div className="puzzle-side">
            <div className={`card puzzle-task ${current.kind}`}>
              <div className="puzzle-kind">
                {t(current.kind === 'punish' ? 'Punish the mistake' : 'Find a better move')}
                {isReview && <span className="puzzle-review">{t('Review')}</span>}
              </div>
              <p>{puzzlePrompt(current)}</p>
              {current.prev && <p className="muted">{t('Last move: {move}', { move: current.prev.name })}</p>}
              {!done && (
                <p className="muted small">
                  {left > 0 ? tn('{n} more puzzle after this one', '{n} more puzzles after this one', left) : t('Last puzzle for now')}
                </p>
              )}
              {hint >= 1 && !done && <p className="hint">💡 {puzzleHint(current)}</p>}
              {hint >= 2 && !done && <p className="hint">💡 {t('The piece to move is highlighted.')}</p>}
              {feedback && <p className={`feedback ${phase}`}>{feedback}</p>}
              {done && current.why.length > 0 && (
                <div className="puzzle-why">
                  <div className="puzzle-kind">{t('Why it works')}</div>
                  {current.why.map((w, k) => (
                    <p key={k}>{w}</p>
                  ))}
                </div>
              )}
              {done && (
                <p className="muted small">
                  {t('Line: {line}', { line: formatLine(current.fen, current.line, 8) })}
                  {t(' · In the game you played {move}.', { move: current.playedSan })}
                </p>
              )}
              {playOn && (
                <div className="puzzle-playon">
                  <div className="puzzle-kind">{t('Play on')}</div>
                  <p className="small">{formatLine(current.fen, played, played.length)}</p>
                  <p className="muted small">
                    {thinking
                      ? t('Opponent is thinking…')
                      : playOn.isCheckmate()
                        ? t('Checkmate.')
                        : playOn.isGameOver()
                          ? t('Game over.')
                          : t('Make a move and the engine answers, to see how the position plays out.')}
                    {playEval && !thinking && ` ${t('Eval {score}', { score: formatScore(playEval) })}`}
                  </p>
                  <div className="row">
                    <button onClick={() => setShowSuggest((v) => !v)} disabled={!myTurn || !suggest}>
                      💡 {t('Best move')}
                    </button>
                    <button onClick={undo} disabled={thinking || played.length < 4}>
                      ↶ {t('Undo')}
                    </button>
                  </div>
                </div>
              )}
              <div className="row">
                {!done ? (
                  <>
                    {hint < 2 && (
                      <button onClick={() => setHint((h) => h + 1)} disabled={phase === 'checking'}>
                        💡 {t('Hint')}
                      </button>
                    )}
                    <button onClick={reveal} disabled={phase === 'checking'}>
                      {t('Show solution')}
                    </button>
                    <button onClick={next} disabled={phase === 'checking'} title={t('Skip (→)')}>
                      {t('Skip')} ›
                    </button>
                  </>
                ) : (
                  <>
                    <button className="primary" onClick={next}>
                      {left > 0 ? t('Next puzzle ({n} left)', { n: left }) : t('Next puzzle')}
                    </button>
                    <button onClick={() => onOpenGame(current.gameKey, current.ply - 1, current.color)}>{t('Open game')}</button>
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

const STATUS_LABEL: Record<Status, string> = { new: 'New', due: 'Due', solved: 'Solved', mastered: 'Mastered' } // shown through t()

function PuzzleList({ puzzles, motifs, filter, setFilter, statusOf, boxOf, onPlay }: ListProps) {
  return (
    <div className="puzzle-list-wrap">
      <div className="puzzle-filters">
        <select value={filter.kind} onChange={(e) => setFilter({ ...filter, kind: e.target.value as Filter['kind'] })}>
          <option value="all">{t('All types')}</option>
          <option value="punish">{t('Punish the mistake')}</option>
          <option value="better">{t('Find a better move')}</option>
        </select>
        <select value={filter.motif} onChange={(e) => setFilter({ ...filter, motif: e.target.value as Filter['motif'] })}>
          <option value="all">{t('All tactics')}</option>
          {motifs.map((m) => (
            <option key={m} value={m}>
              {motifName(m)}
            </option>
          ))}
        </select>
        <select value={filter.status} onChange={(e) => setFilter({ ...filter, status: e.target.value as Filter['status'] })}>
          <option value="all">{t('Any status')}</option>
          {(Object.keys(STATUS_LABEL) as Status[]).map((st) => (
            <option key={st} value={st}>
              {t(STATUS_LABEL[st])}
            </option>
          ))}
        </select>
      </div>
      {puzzles.length === 0 && <p className="muted center">{t('No puzzles match these filters.')}</p>}
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
                  <span className="muted">{t(p.kind === 'punish' ? 'Punish the mistake' : 'Find a better move')}</span>
                  {motif && <span className="pl-motif">{p.theme ? motifName(motif) : t('avoid {tactic}', { tactic: describeTactic({ motif }) })}</span>}
                  <span className="pl-status">
                    <span className={`st st-${st}`}>{t(STATUS_LABEL[st])}</span>
                    <span className="dots" title={t('Mastery')}>
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
