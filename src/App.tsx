import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Chess, DEFAULT_POSITION } from 'chess.js'
import type { DrawShape } from 'chessground/draw'
import type { Key } from 'chessground/types'
import { availableThreads, Engine, type EngineFlavor, type EngineLine, type Score } from './engine'
import { basisName, GLYPH, judgeMove, lineCost, lineLabels, parseGame, rateReview, REVIEW_LIMITS, reviewGame, terminalEval, type Game, type Label, type MoveReview, type Ply, type PositionEval, type Review } from './analysis'
import { explainGood, explainMove, explainPlayed, formatLine, moveName, moveNumber, type MoveExplanation } from './explain'
import { Board } from './components/Board'
import { EvalBar } from './components/EvalBar'
import { EvalGraph } from './components/EvalGraph'
import { MoveList } from './components/MoveList'
import { ImportPanel } from './components/ImportPanel'
import { EngineLines } from './components/EngineLines'
import { PositionChat } from './components/PositionChat'
import { PlayCard, PlaySetup, type PlaySettings } from './components/PlayCard'
import { BOT_LINES, botMove } from './bot'
import type { PositionContext } from './aiPrompt'
import { SummaryCard, type DeepState } from './components/SummaryCard'
import { restoreSession, saveSession, type RestoredSession } from './session'
import { positionLinkBase, samePosition, sanToUci, takePositionLink } from './positionLink'
import { LineBanner } from './components/LineBanner'
import { PatternsView } from './components/PatternsView'
import { PuzzleView } from './components/PuzzleView'
import { getStoredGame, type StoredGame } from './store'
import { brilliantMoves, isBrilliant } from './brilliant'
import { findGreatMoves, greatText, judgeGreat, type GreatMove } from './greatMoves'
import { bookInfo, bookMovesInLine, followBook, loadOpenings, type BookInfo, type Db as OpeningDb } from './openings'
import { setLang, t, useLang } from './i18n'

const DEEP_LIMITS = { depth: 22, movetimeMs: 3000 } // full engine; the time cap keeps hard positions bounded
const LIVE_DEPTH = { lite: 20, full: 24 }
const LIVE_LINES = 3
const EXPLAIN_PLIES = 8
const MIN_JUDGE_DEPTH = 12 // live evals below this depth are too shaky to judge a side-line move with
const EVAL_CACHE_SIZE = 400

type CachedEval = PositionEval & {
  depth: number
  second?: { score: Score; move: string } // second-best line, to tell whether the best move was the only good one
  bestSince?: number // depth from which the best move has stayed on top, to tell whether it was hard to find
  lines?: EngineLine[] // all live lines, so a move played from one of them is judged by that line's own score
  scoreAt?: Record<number, Score> // best-line score per depth, to compare with a position searched less deeply
}

/** Remembers the live engine's best line per position, so side-line moves can be judged from before/after evals. */
function cacheEval(cache: Map<string, CachedEval>, fen: string, lines: EngineLine[]): Map<string, CachedEval> {
  const [line, second] = lines
  const old = cache.get(fen)
  if (old && old.depth > line.depth) return cache
  const next = new Map(cache)
  next.delete(fen) // re-insert so the oldest entries are evicted first
  next.set(fen, {
    score: line.score,
    bestMove: line.pv[0] ?? null,
    pv: line.pv,
    depth: line.depth,
    second: second?.pv.length && second.depth === line.depth ? { score: second.score, move: second.pv[0] } : old?.second,
    bestSince: old && old.bestMove === line.pv[0] ? Math.min(old.bestSince ?? line.depth, line.depth) : line.depth,
    lines: lines.filter((l) => l.pv.length),
    scoreAt: { ...old?.scoreAt, [line.depth]: line.score },
  })
  if (next.size > EVAL_CACHE_SIZE) next.delete(next.keys().next().value!)
  return next
}

const startsWith = (line: string[], prefix: string[]) => prefix.length <= line.length && prefix.every((m, i) => line[i] === m)
const LIVE_FLAVOR_KEY = 'chess-analyzer:live-engine'

/** Why a great move was the only good one, and whether it was hard to spot. */
function GreatNote({ great }: { great: GreatMove }) {
  const { only, hard } = greatText(great, t)
  return (
    <p className="why">
      {only}
      {hard && (
        <>
          {' '}
          <strong>{hard}</strong>
        </>
      )}
    </p>
  )
}

/** The side the user played, if their saved username from "My games" matches a player. */
function playedSide(game: Game): 'w' | 'b' | null {
  try {
    const user = (JSON.parse(localStorage.getItem('chess-analyzer:import') ?? 'null')?.user ?? '').trim().toLowerCase()
    if (user && game.meta.white.toLowerCase() === user) return 'w'
    if (user && game.meta.black.toLowerCase() === user) return 'b'
  } catch {
    /* storage unavailable */
  }
  return null
}

/** The side the user most likely played: the username match, else the board orientation. */
function mySide(game: Game, orientation: 'white' | 'black'): 'w' | 'b' {
  return playedSide(game) ?? (orientation === 'white' ? 'w' : 'b')
}

/** Live engine setting: off saves power; the review's best line is shown instead. */
type LiveMode = 'off' | EngineFlavor

function savedLiveMode(): LiveMode {
  try {
    const v = localStorage.getItem(LIVE_FLAVOR_KEY)
    return v === 'full' || v === 'off' ? v : 'lite'
  } catch {
    return 'lite'
  }
}

/** Whether the page is visible (false when the tab is in the background or the screen is off). */
function usePageVisible() {
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden')
  useEffect(() => {
    const on = () => setVisible(document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', on)
    return () => document.removeEventListener('visibilitychange', on)
  }, [])
  return visible
}

/** Whether an element is at least partly on screen. */
function useInView(ref: React.RefObject<HTMLElement | null>) {
  const [inView, setInView] = useState(true)
  useEffect(() => {
    const el = ref.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(([e]) => setInView(e.isIntersecting), { threshold: 0.15 })
    io.observe(el)
    return () => io.disconnect()
  }, [ref])
  return inView
}

const LABEL_TEXT: Record<Label, string> = {
  best: 'Best move',
  good: 'Good move',
  inaccuracy: 'Inaccuracy',
  mistake: 'Mistake',
  blunder: 'Blunder',
} // English keys; shown through t()

const BRILLIANT_COLOR = '#1fb5a5'
const GREAT_COLOR = '#5b9be0'

const LABEL_COLOR: Record<Label, string> = {
  best: '#5fb35a',
  good: '#8aa66d',
  inaccuracy: '#e6b53c',
  mistake: '#e08a2c',
  blunder: '#d9453b',
}

const emptyGame = (): Game => ({
  meta: { white: 'White', black: 'Black', result: '*' },
  startFen: DEFAULT_POSITION,
  plies: [],
})

/** Arrow brush per line quality (brushes are defined in Board). */
const LINE_BRUSH: Record<Label, string> = {
  best: 'paleGreen',
  good: 'lineGood',
  inaccuracy: 'lineInaccuracy',
  mistake: 'lineMistake',
  blunder: 'lineBlunder',
}

const BADGE_COLOR: Record<Label, [string, string]> = {
  best: ['#5fb35a', '#10200d'],
  good: ['#7fb069', '#10200d'],
  inaccuracy: ['#e6b53c', '#2a1f05'],
  mistake: ['#e08a2c', '#ffffff'],
  blunder: ['#d9453b', '#ffffff'],
}

/** A pill-shaped badge drawn on an arrow (chessground draws it in a 100×100 box the size of a square). */
function arrowBadge(text: string, label: Label) {
  const [bg, fg] = BADGE_COLOR[label]
  const w = Math.min(96, 30 + text.length * 17)
  return `<rect x="${50 - w / 2}" y="31" width="${w}" height="38" rx="19" fill="${bg}" stroke="rgba(0,0,0,.35)" stroke-width="2"/>
<text x="50" y="58" text-anchor="middle" font-size="28" font-weight="700" font-family="system-ui, sans-serif" fill="${fg}">${text}</text>`
}

const shape = (uci: string, brush: string, lineWidth?: number): DrawShape => ({
  orig: uci.slice(0, 2) as Key,
  dest: uci.slice(2, 4) as Key,
  brush,
  modifiers: lineWidth ? { lineWidth } : undefined,
})

/** An explanation being shown on the board: the refutation of a move, or the better alternative. */
interface Explaining {
  ply: number // 1-based mainline ply of the move being explained
  kind: 'why' | 'best'
}

const emptyDeep: DeepState = { status: 'idle', done: 0, total: 0, startedAt: 0, elapsedMs: 0 }

interface OpenedLink {
  game: Game
  ply: number // mainline ply the line starts from
  line: string[] // UCI
  bad: string | null // the first move in the link that wasn't legal (the line stops before it)
}

/**
 * What to show on load: the saved session, or a position link (from an AI chat). A link into the saved game opens
 * that game at the position; any other link opens just the position and leaves the saved game alone.
 */
function startup(): { restored: RestoredSession | null; link: OpenedLink | null } {
  const session = restoreSession()
  const link = takePositionLink()
  if (!link) return { restored: session, link: null }
  const fens = session ? [session.game.startFen, ...session.game.plies.map((p) => p.fenAfter)] : []
  let at = fens.findIndex((f) => samePosition(f, link.fen))
  const { uci, bad } = sanToUci(link.fen, link.moves)
  // Moves that were played in the game just step forward in it; the side line starts where they differ.
  let line = uci
  while (at >= 0 && line.length && session!.game.plies[at]?.uci === line[0]) {
    at++
    line = line.slice(1)
  }
  return {
    restored: at >= 0 ? session : null,
    link: { game: at >= 0 ? session!.game : { ...emptyGame(), startFen: link.fen }, ply: Math.max(at, 0), line, bad },
  }
}

export default function App() {
  const lang = useLang()
  const [{ restored, link }] = useState(startup) // read once, on first render
  const [pgn, setPgn] = useState(restored?.pgn ?? '')
  const [game, setGame] = useState<Game>(() => link?.game ?? restored?.game ?? emptyGame())
  const [ply, setPly] = useState(link?.ply ?? restored?.ply ?? 0)
  const [variation, setVariation] = useState<string[]>(link?.line.slice(0, 1) ?? []) // UCI moves branching off the mainline at `ply`
  const [plan, setPlan] = useState<string[]>(link?.line ?? []) // the full side line `variation` is a prefix of (for stepping forward)
  const [explaining, setExplaining] = useState<Explaining | null>(null)
  const [orientation, setOrientation] = useState<'white' | 'black'>(
    restored?.orientation ?? (link && link.game.startFen.split(' ')[1] === 'b' ? 'black' : 'white'),
  )
  const [review, setReview] = useState<Review | null>(restored?.review ?? null)
  const [book, setBook] = useState<{ game: Game; db: OpeningDb; info: BookInfo } | null>(null)
  const [partialEvals, setPartialEvals] = useState<PositionEval[]>([])
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [live, setLive] = useState<{ fen: string; lines: EngineLine[] } | null>(null)
  const [evalCache, setEvalCache] = useState<Map<string, CachedEval>>(() => new Map())
  // "Show why/best" for a move played in a side line: the side line up to and including that move
  const [varExplain, setVarExplain] = useState<{ judged: string[]; kind: 'why' | 'best' } | null>(null)
  const [showImport, setShowImport] = useState(!restored && !link)
  const [error, setError] = useState<string | null>(() =>
    link?.bad ? t('The link has a move that is not legal here ({move}); showing the line up to it.', { move: link.bad }) : null,
  )
  const [tab, setTab] = useState<'summary' | 'moves'>(restored?.review ? restored.tab : 'moves')
  const [view, setView] = useState<'analyze' | 'patterns' | 'puzzles'>('analyze')
  const [deep, setDeep] = useState<DeepState>(restored?.deepDone ? { ...emptyDeep, status: 'done' } : emptyDeep)
  const [liveMode, setLiveMode] = useState<LiveMode>(savedLiveMode)
  const [play, setPlay] = useState<PlaySettings | null>(null) // playing on against the computer from the board position
  const pageVisible = usePageVisible()
  const boardRef = useRef<HTMLDivElement>(null)
  const boardInView = useInView(boardRef)
  const [engineError, setEngineError] = useState<string | null>(null)

  const liveEngine = useRef<Engine | null>(null)
  const reviewEngine = useRef<Engine | null>(null)
  const deepEngine = useRef<Engine | null>(null)
  const botEngine = useRef<Engine | null>(null)
  const reviewToken = useRef(0)

  useEffect(() => {
    reviewEngine.current = new Engine({ onError: (m) => setEngineError(t('Review engine failed to start: {error}', { error: m })) })
    return () => {
      reviewEngine.current?.terminate()
      deepEngine.current?.terminate()
    }
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem(LIVE_FLAVOR_KEY, liveMode)
    } catch {
      /* storage unavailable */
    }
    if (liveMode === 'off') {
      liveEngine.current = null // no worker at all: frees its CPU and memory
      return
    }
    const onError = (m: string) => setEngineError(t(liveMode === 'full' ? 'Full engine failed to start: {error}' : 'Lite engine failed to start: {error}', { error: m }))
    const engine =
      liveMode === 'full'
        ? new Engine({ multiPv: LIVE_LINES, flavor: 'full', threads: availableThreads(), hashMb: 64, onError })
        : new Engine({ multiPv: LIVE_LINES, onError })
    liveEngine.current = engine
    return () => engine.terminate()
  }, [liveMode])

  // --- Positions -----------------------------------------------------------

  const mainFen = ply === 0 ? game.startFen : game.plies[ply - 1].fenAfter
  const varLine = useMemo(() => {
    const chess = new Chess(mainFen)
    return variation.map((uci) => {
      const m = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] })
      return { uci, san: m.san, fen: chess.fen(), color: m.color }
    })
  }, [mainFen, variation])

  const fen = varLine.length ? varLine[varLine.length - 1].fen : mainFen
  const lastMove = varLine.length ? varLine[varLine.length - 1].uci : ply > 0 ? game.plies[ply - 1].uci : undefined
  const inVariation = varLine.length > 0
  const gameOver = useMemo(() => new Chess(fen).isGameOver(), [fen])

  // --- Loading & review ----------------------------------------------------

  const stopDeep = () => {
    deepEngine.current?.terminate()
    deepEngine.current = null
    setDeep(emptyDeep)
  }

  const startReview = useCallback((g: Game) => {
    const token = ++reviewToken.current
    reviewEngine.current?.stop()
    stopDeep()
    setReview(null)
    setPartialEvals([])
    if (g.plies.length === 0) {
      setProgress(null)
      return
    }
    setProgress({ done: 0, total: g.plies.length + 1 })
    void reviewGame(
      g,
      reviewEngine.current!,
      REVIEW_LIMITS,
      (done, total, evals) => {
        if (token !== reviewToken.current) return
        setProgress({ done, total })
        setPartialEvals(evals)
      },
      () => token !== reviewToken.current,
    ).then((r) => {
      if (token !== reviewToken.current || !r) return
      setReview(r)
      setProgress(null)
      setTab('summary')
    })
  }, [])

  /** Re-reviews the game with the full engine in the background, then swaps in its labels and evals. */
  const startDeep = () => {
    if (!review || deep.status === 'running') return
    const token = reviewToken.current
    const fast = review
    const engine = new Engine({
      flavor: 'full',
      threads: availableThreads(),
      hashMb: 128,
      onError: (m) => setEngineError(t('Deep analysis engine failed to start: {error}', { error: m })),
    })
    deepEngine.current = engine
    const total = game.plies.length + 1
    setDeep({ status: 'running', done: 0, total, startedAt: Date.now(), elapsedMs: 0 })
    void reviewGame(
      game,
      engine,
      DEEP_LIMITS,
      (done) => {
        if (token === reviewToken.current) setDeep((d) => ({ ...d, done, elapsedMs: Date.now() - d.startedAt }))
      },
      () => token !== reviewToken.current || deepEngine.current !== engine,
    ).then((r) => {
      if (token !== reviewToken.current || deepEngine.current !== engine || !r) return
      engine.terminate()
      deepEngine.current = null
      // Keep the estimated rating from the fast review: it is calibrated on fast-review numbers.
      setReview({ ...r, acpl: fast.acpl, rating: fast.rating })
      setDeep((d) => ({ ...d, status: 'done', done: total }))
    })
  }

  const resetLine = () => {
    setVariation([])
    setPlan([])
    setExplaining(null)
    setPlay(null)
  }

  /** Opens an already-reviewed game (from My patterns) at a given move, without reviewing it again. */
  const openReviewed = (stored: StoredGame, atPly: number, me: 'w' | 'b') => {
    reviewToken.current++
    reviewEngine.current?.stop()
    stopDeep()
    const g = parseGame(stored.pgn)
    setPgn(stored.pgn)
    setGame(g)
    setReview(rateReview(stored.review, g))
    setPartialEvals([])
    setProgress(null)
    resetLine()
    setPly(atPly)
    setOrientation(me === 'w' ? 'white' : 'black')
    setTab('moves')
    setShowImport(false)
    setError(null)
    setView('analyze')
    window.scrollTo(0, 0)
  }

  const loadPgn = useCallback(
    (text: string) => {
      try {
        const g = parseGame(text)
        setPgn(text)
        setGame(g)
        setPly(0)
        resetLine()
        setError(null)
        setShowImport(false)
        setTab('moves')
        startReview(g)
      } catch (e) {
        setError(t('Could not read that PGN: {error}', { error: e instanceof Error ? e.message : String(e) }))
      }
    },
    [startReview],
  )

  // A restored game without a finished review (e.g. the tab was discarded mid-review) is reviewed again.
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- starts the engine (an external system)
    if (restored && restored.game.plies.length > 0 && !restored.review) startReview(restored.game)
  }, [restored, startReview])

  useEffect(() => {
    if (!pgn) return
    saveSession({ pgn, ply, orientation, tab, review, deepDone: deep.status === 'done' })
  }, [pgn, ply, orientation, tab, review, deep.status])

  // --- Great moves ---------------------------------------------------------
  // After the review (and not while the deep analysis runs), a background engine with two lines finds the moves
  // that were the only good one. The result is stored with the review, so it survives reloads.
  useEffect(() => {
    if (!review || review.great || progress || deep.status === 'running' || game.plies.length === 0) return
    let cancelled = false
    const engine = new Engine({ multiPv: 2, onError: () => {} }) // optional extra: fail silently
    void findGreatMoves(game, review, engine, () => cancelled).then((great) => {
      engine.terminate()
      if (!cancelled && great) setReview((r) => (r === review ? { ...r, great } : r))
    })
    return () => {
      cancelled = true
      engine.terminate()
    }
  }, [review, game, progress, deep.status])

  // --- Live engine ---------------------------------------------------------

  // The live engine only runs while someone can see the board: not in a background tab or with the screen off,
  // not on the patterns/puzzles screens, and not while the board is scrolled out of view.
  // Nor while playing against the computer: its arrows and eval would give the moves away.
  const liveActive = liveMode !== 'off' && pageVisible && view === 'analyze' && boardInView && !play
  useEffect(() => {
    const engine = liveEngine.current
    if (!engine) return
    engine.stop()
    if (gameOver || !liveActive) return
    const timer = setTimeout(() => {
      void engine.analyze(fen, { depth: LIVE_DEPTH[liveMode] }, (lines) => {
        setLive({ fen, lines })
        if (lines[0]) setEvalCache((c) => cacheEval(c, fen, lines))
      })
    }, 120)
    return () => clearTimeout(timer)
  }, [fen, gameOver, liveMode, liveActive])

  const reviewedEval = !inVariation ? (review?.evals[ply] ?? partialEvals[ply]) : undefined
  // Live lines for this position if we have them; otherwise (engine off or paused) the review's best line.
  const fromReview = (live?.fen !== fen || liveMode === 'off') && !!reviewedEval?.pv.length
  const liveLines = useMemo<EngineLine[]>(() => {
    if (live?.fen === fen && liveMode !== 'off') return live.lines
    if (reviewedEval?.pv.length) return [{ multipv: 1, depth: REVIEW_LIMITS.depth, score: reviewedEval.score, pv: reviewedEval.pv }]
    return []
  }, [live, fen, liveMode, reviewedEval])
  const shownScore = liveLines[0]?.score ?? reviewedEval?.score ?? null
  const liveLabels = useMemo(() => lineLabels(liveLines.map((l) => l.score), fen.split(' ')[1] === 'w'), [liveLines, fen])

  // --- Navigation ----------------------------------------------------------

  const goTo = useCallback(
    (p: number) => {
      resetLine()
      setPly(Math.max(0, Math.min(game.plies.length, p)))
    },
    [game.plies.length],
  )

  // While a side line is open (`plan` non-empty), stepping moves within it until you go back to the game.
  // Against the computer, stepping stays within that game.
  const step = useCallback(
    (d: number) => {
      if (plan.length || play) {
        if (d > 0 && variation.length < plan.length) setVariation(plan.slice(0, variation.length + 1))
        else if (d < 0 && variation.length) setVariation(variation.slice(0, -1))
        return
      }
      goTo(ply + d)
    },
    [plan, variation, goTo, ply, play],
  )

  /** Enters a side line from the given mainline ply, showing its first move; step through the rest. */
  const enterLine = (fromPly: number, moves: string[]) => {
    setPly(fromPly)
    setPlan(moves)
    setVariation(moves.slice(0, 1))
  }

  const onBoardMove = useCallback(
    (uci: string) => {
      // Playing the next mainline move just advances; anything else starts/extends a variation.
      // Against the computer every move goes into the side line, which holds that game.
      if (!play && !plan.length && game.plies[ply]?.uci === uci) {
        setPly(ply + 1)
        return
      }
      // The board reports a move a moment after it's made; if the position changed in between (a quick step
      // back), the move no longer fits and is dropped.
      try {
        new Chess(fen).move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] })
      } catch {
        return
      }
      const next = [...variation, uci]
      setVariation(next)
      if (plan[variation.length] !== uci) {
        setPlan(next)
        setExplaining(null)
      }
    },
    [variation, plan, game.plies, ply, play, fen],
  )

  // --- Playing against the computer ------------------------------------------

  const startPlay = (settings: PlaySettings) => {
    setExplaining(null)
    setVarExplain(null)
    setPlan(variation) // the game continues from the board; drop the rest of a side line being stepped through
    setPlay(settings)
    setOrientation(settings.bot === 'w' ? 'black' : 'white')
  }

  const onBoardMoveRef = useRef(onBoardMove)
  useEffect(() => {
    onBoardMoveRef.current = onBoardMove
  })
  useEffect(() => {
    if (!play) {
      botEngine.current?.terminate()
      botEngine.current = null
    }
  }, [play])
  useEffect(() => () => botEngine.current?.terminate(), [])
  // Looking back at earlier moves: the game waits until you're back at the latest position.
  const playAtEnd = variation.length === plan.length
  useEffect(() => {
    if (!play || !playAtEnd || gameOver || fen.split(' ')[1] !== play.bot) return
    botEngine.current ??= new Engine({
      multiPv: BOT_LINES,
      onError: (m) => setEngineError(t('Lite engine failed to start: {error}', { error: m })),
    })
    const engine = botEngine.current
    let cancelled = false
    const started = Date.now()
    void botMove(engine, fen, play.strength, game.meta).then(async (uci) => {
      // A moment's pause, so an instant reply doesn't land before your own move has finished animating
      const wait = 700 - (Date.now() - started)
      if (wait > 0) await new Promise((r) => setTimeout(r, wait))
      if (!cancelled && uci) onBoardMoveRef.current(uci)
    })
    return () => {
      cancelled = true
      engine.stop()
    }
  }, [play, playAtEnd, fen, gameOver, game.meta])

  // Forced mate in the current position (live engine, or the review when live analysis is off/paused)
  const mateIn = shownScore?.mate !== undefined && Math.abs(shownScore.mate) >= 1 ? Math.round(shownScore.mate) : null
  // Mate in n takes 2n-1 plies when the mating side is to move, 2n when the defender moves first.
  const matingSideToMove = mateIn !== null && (mateIn > 0) === (fen.split(' ')[1] === 'w')
  const mateLine =
    mateIn !== null && liveLines[0]?.score.mate !== undefined
      ? liveLines[0].pv.slice(0, Math.abs(mateIn) * 2 - (matingSideToMove ? 1 : 0))
      : []
  // Already stepping through this mating line? Then there's nothing to show.
  const inMateLine = mateLine.length > 0 && plan.slice(variation.length, variation.length + mateLine.length).join(' ') === mateLine.join(' ')
  /** Step through the mating line on the board, like other side lines. */
  const showMate = () => {
    if (!mateLine.length) return
    setExplaining(null)
    setPlan([...variation, ...mateLine])
    setVariation([...variation, mateLine[0]])
  }

  const onEngineLine = (moves: string[]) => {
    const next = [...variation, ...moves]
    setExplaining(null)
    setPlan(next)
    setVariation(next)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (e.key === 'ArrowLeft') step(-1)
      else if (e.key === 'ArrowRight') step(1)
      else if (e.key === 'Home' || e.key === 'ArrowUp') (play ? setVariation([]) : goTo(0))
      else if (e.key === 'End' || e.key === 'ArrowDown') (play ? setVariation(plan) : goTo(game.plies.length))
      else if (e.key === 'f') setOrientation((o) => (o === 'white' ? 'black' : 'white'))
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [step, goTo, game.plies.length, play, plan])

  // --- Move verdict & explanation ------------------------------------------

  // Opening book for the loaded game (data loads on demand, so it arrives a moment after the game)
  useEffect(() => {
    let cancelled = false
    void loadOpenings().then((db) => !cancelled && setBook({ game, db, info: bookInfo(game, db) }))
    return () => {
      cancelled = true
    }
  }, [game])
  const bookNow = book?.game === game ? book.info : null
  const bookPlies = bookNow?.bookPlies ?? 0
  const brilliant = useMemo(() => (review ? brilliantMoves(game, review, bookPlies) : new Set<number>()), [game, review, bookPlies])
  // Great moves by ply index: book moves are theory and brilliant moves already get the higher mark
  const great = useMemo(() => {
    const out = new Map<number, GreatMove>()
    for (const [i, g] of Object.entries(review?.great ?? {})) if (Number(i) >= bookPlies && !brilliant.has(Number(i))) out.set(Number(i), g)
    return out
  }, [review, bookPlies, brilliant])

  // Book status of a side line played from a book position on the main line
  const varBook = useMemo(() => {
    if (!book || book.game !== game || !inVariation) return null
    const mainInBook = book.info.fromStart && ply <= book.info.bookPlies
    if (!mainInBook) return null
    return followBook(book.db, varLine.map((v) => v.fen), book.info.openingAt[ply])
  }, [book, game, inVariation, ply, varLine])
  const varIsBook = !!varBook && varBook.plies === varLine.length
  // The position on the board is reached by book moves only, so engine lines from it can be book too
  const positionInBook = inVariation ? varIsBook : !!bookNow?.fromStart && ply <= bookPlies
  const lineBookMoves = useMemo(
    () => (positionInBook && book ? liveLines.map((l) => bookMovesInLine(book.db, fen, l.pv.slice(0, 10))) : undefined),
    [positionInBook, book, liveLines, fen],
  )

  const verdictPly = explaining ? explaining.ply : !inVariation && ply > 0 ? ply : null
  const isBookMove = !!verdictPly && !explaining && verdictPly <= bookPlies
  const verdict = verdictPly && review ? review.moves[verdictPly - 1] : undefined
  const explanation = useMemo(
    () => (verdictPly && review ? explainMove(game, review, verdictPly - 1) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- lang: the text is generated in the current language
    [game, review, verdictPly, lang],
  )
  const goodNote = useMemo(() => {
    if (!verdictPly || !review) return null
    const i = verdictPly - 1
    const prev = i > 0 ? { uci: game.plies[i - 1].uci, rv: review.moves[i - 1] } : undefined
    return explainGood(game.meta, game.plies[i], review.moves[i], review.evals[i], review.evals[i + 1], prev)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- lang: the text is generated in the current language
  }, [game, review, verdictPly, lang])

  // --- Side-line move verdict ----------------------------------------------
  // A move played in a side line is judged like a game move, from the live engine's evals before and after it.

  const varExplainOn =
    !!varExplain && !explaining && startsWith(plan, varExplain.kind === 'why' ? varExplain.judged : varExplain.judged.slice(0, -1))
  const judgedLine = varExplainOn ? varExplain.judged : inVariation && !explaining ? variation : null
  const sideVerdict = useMemo(() => {
    if (!judgedLine?.length) return null
    const chess = new Chess(mainFen)
    let played: Ply | null = null
    let prevPly: Ply | undefined
    for (const uci of judgedLine) {
      const fenBefore = chess.fen()
      const m = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] })
      prevPly = played ?? undefined
      played = { san: m.san, uci, fenBefore, fenAfter: chess.fen(), color: m.color }
    }
    const evalAt = (f: string): PositionEval | null => {
      const cached = evalCache.get(f)
      if (cached && cached.depth >= MIN_JUDGE_DEPTH) return cached
      if (f === mainFen && review) return review.evals[ply]
      return terminalEval(f)
    }
    let before = evalAt(played!.fenBefore)
    const cached = evalCache.get(played!.fenBefore)
    const fromCache = !!cached && before === cached
    // A move from one of the live lines is judged by that line's score: it comes from the same search as the
    // best line, so the verdict agrees with the arrows.
    const asLine = fromCache ? cached.lines?.find((l) => l.pv[0] === played!.uci) : undefined
    let after =
      terminalEval(played!.fenAfter) ??
      (asLine ? { score: asLine.score, bestMove: asLine.pv[1] ?? null, pv: asLine.pv.slice(1) } : evalAt(played!.fenAfter))
    // Otherwise compare the two positions at matching depths: a deep eval before the move against a shallow
    // one after it (or the other way round) can make the engine's own best move look like a blunder.
    const afterCached = evalCache.get(played!.fenAfter)
    if (!asLine && fromCache && afterCached && after === afterCached) {
      const d = Math.min(cached.depth, afterCached.depth + 1)
      const b = cached.scoreAt?.[d]
      const a = afterCached.scoreAt?.[d - 1]
      if (b && a) {
        before = { ...cached, score: b }
        after = { ...afterCached, score: a }
      }
    }
    if (!before || !after) return { ply: played!, rv: null, brilliant: false, great: null, explanation: null, note: null }
    const rv = judgeMove(played!, before, after)
    const brill = isBrilliant(played!, rv, before, after)
    const prev = prevPly ?? (ply > 0 ? game.plies[ply - 1] : undefined)
    const greatMove =
      !brill && cached && cached.depth >= MIN_JUDGE_DEPTH
        ? judgeGreat(played!, prev, { score: cached.score, move: cached.bestMove }, cached.second ?? null, cached.bestSince ?? null)
        : null
    return {
      ply: played!,
      rv,
      brilliant: brill,
      great: greatMove,
      explanation: explainPlayed(game.meta, played!, rv, before, after),
      note: explainGood(game.meta, played!, rv, before, after, prev && { uci: prev.uci }),
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- lang: the text is generated in the current language
  }, [judgedLine, mainFen, evalCache, review, ply, game.meta, lang])

  const showSideExplanation = (kind: 'why' | 'best') => {
    if (!judgedLine || !sideVerdict?.explanation) return
    const base = kind === 'why' ? judgedLine : judgedLine.slice(0, -1)
    const line = (kind === 'why' ? sideVerdict.explanation.refutation : sideVerdict.explanation.best).slice(0, EXPLAIN_PLIES)
    if (!line.length) return
    setVarExplain({ judged: judgedLine, kind })
    setPlan([...base, ...line])
    setVariation([...base, line[0]])
  }

  const showExplanation = (kind: Explaining['kind']) => {
    if (!verdictPly || !explanation) return
    setExplaining({ ply: verdictPly, kind })
    if (kind === 'why') enterLine(verdictPly, explanation.refutation.slice(0, EXPLAIN_PLIES))
    else enterLine(verdictPly - 1, explanation.best.slice(0, EXPLAIN_PLIES))
  }

  // The verdict card: the game move on the board (or being explained), else the side-line move
  const card: {
    num: string
    san: string
    rv: MoveReview
    brilliant: boolean
    great: GreatMove | null
    explanation: MoveExplanation | null
    note: string | null // what a good move does (a tactic, punishing a mistake), when there's no explanation
    kind?: 'why' | 'best'
    show: (k: 'why' | 'best') => void
  } | null =
    isBookMove || varIsBook
      ? null
      : verdict && verdictPly
        ? {
            num: moveNumber(game.plies[verdictPly - 1]),
            san: game.plies[verdictPly - 1].san,
            rv: verdict,
            brilliant: brilliant.has(verdictPly - 1),
            great: great.get(verdictPly - 1) ?? null,
            explanation,
            note: goodNote,
            kind: explaining?.kind,
            show: showExplanation,
          }
        : sideVerdict?.rv
          ? {
              num: moveNumber(sideVerdict.ply),
              san: sideVerdict.ply.san,
              rv: sideVerdict.rv,
              brilliant: sideVerdict.brilliant,
              great: sideVerdict.great,
              explanation: sideVerdict.explanation,
              note: sideVerdict.note,
              kind: varExplainOn ? varExplain!.kind : undefined,
              show: showSideExplanation,
            }
          : null
  // A side-line move still waiting for the engine (shown as "checking…")
  const sidePending = !card && !varIsBook && !!sideVerdict && !sideVerdict.rv && sideVerdict.ply.fenAfter === fen

  /** Everything about the position on the board for "Chat about this position" (built when the button is pressed). */
  const positionContext = (): PositionContext => {
    const at = <T,>(list: T[] | undefined, i: number) => (list?.length ? list[Math.min(i, list.length - 1)] : undefined)
    const opening = (varBook && at(varBook.openingAt, varLine.length - 1)) || at(bookNow?.openingAt, ply) || null
    // The move that led to the position, unless the board shows a line being explained for another move
    const bookLast = !explaining && ((!inVariation && isBookMove) || varIsBook)
    const lastMove = bookLast
      ? { name: inVariation ? varLine[varLine.length - 1].san : moveName(game, ply - 1), verdict: 'a book move (known opening theory)', comment: null }
      : card && !card.kind
        ? {
            name: `${card.num} ${card.san}`,
            verdict: card.brilliant ? 'brilliant move' : card.great ? 'great move (the only good move)' : LABEL_TEXT[card.rv.label].toLowerCase(),
            comment: card.explanation?.text ?? card.note,
          }
        : null
    return {
      game,
      ply,
      variation: varLine.map((v) => v.san),
      fen,
      me: playedSide(game),
      opening: opening?.name ?? game.meta.opening ?? null,
      lines: liveLines,
      lastMove,
      link: positionLinkBase(mainFen, varLine.map((v) => v.san)),
    }
  }

  // --- Board annotations ---------------------------------------------------

  const shapes = useMemo(() => {
    const out: DrawShape[] = []
    if (play) return out
    // Arrows for the engine lines, coloured by how they compare with the best line; drawn worst first so
    // the best arrow ends up on top where they overlap.
    liveLines
      .map((line, i) => ({ line, i }))
      .reverse()
      .forEach(({ line, i }) => {
        if (!line.pv[0]) return
        const label = liveLabels[i] ?? 'best'
        const arrow = shape(line.pv[0], LINE_BRUSH[label], i === 0 ? undefined : 7)
        // Alternatives get a badge on the arrow saying how much worse they are than the best line.
        const badge = i > 0 ? lineCost(liveLines[0].score, line.score, fen.split(' ')[1] === 'w').badge : null
        if (badge) arrow.customSvg = { html: arrowBadge(badge, label), center: 'label' }
        out.push(arrow)
      })
    if (verdict && !inVariation && verdictPly === ply && !isBookMove) {
      const played = game.plies[ply - 1]
      const glyph = brilliant.has(ply - 1) ? '!!' : great.has(ply - 1) ? '!' : GLYPH[verdict.label]
      const fill = brilliant.has(ply - 1) ? BRILLIANT_COLOR : great.has(ply - 1) ? GREAT_COLOR : LABEL_COLOR[verdict.label]
      if (glyph) out.push({ orig: played.uci.slice(2, 4) as Key, label: { text: glyph, fill } })
    }
    if (sideVerdict?.rv && !varExplainOn && sideVerdict.ply.fenAfter === fen && !varIsBook) {
      const glyph = sideVerdict.brilliant ? '!!' : sideVerdict.great ? '!' : GLYPH[sideVerdict.rv.label]
      const fill = sideVerdict.brilliant ? BRILLIANT_COLOR : sideVerdict.great ? GREAT_COLOR : LABEL_COLOR[sideVerdict.rv.label]
      if (glyph) out.push({ orig: sideVerdict.ply.uci.slice(2, 4) as Key, label: { text: glyph, fill } })
    }
    return out
  }, [liveLines, liveLabels, fen, verdict, verdictPly, inVariation, game.plies, ply, isBookMove, sideVerdict, varExplainOn, varIsBook, brilliant, great, play])

  // --- Render --------------------------------------------------------------

  const { meta } = game
  const top = orientation === 'white' ? 'b' : 'w'
  const player = (c: 'w' | 'b') => (
    <div className="player">
      <span className={`swatch ${c}`} />
      <span className="name">{c === 'w' ? meta.white : meta.black}</span>
      {(c === 'w' ? meta.whiteElo : meta.blackElo) && <span className="elo">{c === 'w' ? meta.whiteElo : meta.blackElo}</span>}
      {review && (
        <span className="player-stats">
          <span
            className="est"
            title={
              t('Estimated rating for this game, compared with {basis} players', { basis: basisName(review.rating[c].basis) }) +
              (review.rating[c].reliable ? '' : t(' (game too short to be reliable)')) +
              (review.rating[c].precision === 'rough' ? t(' (rough: single fast games vary a lot)') : '')
            }
          >
            ~{review.rating[c].value}
            {(!review.rating[c].reliable || review.rating[c].precision === 'rough') && '?'}
          </span>
          <span className="acc">{review.accuracy[c].toFixed(1)}%</span>
        </span>
      )}
    </div>
  )
  const inLine = plan.length > 0
  const canStepForward = inLine || play ? variation.length < plan.length : ply < game.plies.length
  const canStepBack = inLine || play ? variation.length > 0 : ply > 0
  const exitLine = () => goTo(explaining ? explaining.ply : ply)
  const navTo = play ? () => {} : goTo
  const playEndFen = useMemo(() => {
    if (!play) return fen
    const chess = new Chess(mainFen)
    for (const uci of plan) chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] })
    return chess.fen()
  }, [play, fen, mainFen, plan])
  /** A player of the game and how strong they are: their rating in the game, else the review's estimate. */
  const playerInfo = (c: 'w' | 'b') => {
    const elo = Number(c === 'w' ? meta.whiteElo : meta.blackElo)
    return { name: c === 'w' ? meta.white : meta.black, rating: elo > 0 ? elo : (review?.rating[c].value ?? null) }
  }
  const lineTitle = play
    ? t('Your game against the computer')
    : !explaining
    ? varExplainOn && sideVerdict
      ? varExplain!.kind === 'why'
        ? t('{move}: how it can be punished', { move: sideVerdict.ply.san })
        : t('What could have been played instead of {move}', { move: sideVerdict.ply.san })
      : t('Alternate line')
    : explaining.kind === 'why'
      ? t('{move}: how {opponent} can punish it', {
          move: moveName(game, explaining.ply - 1),
          opponent: game.plies[explaining.ply - 1].color === 'w' ? meta.black : meta.white,
        })
      : t('What {player} could have played instead of {move}', {
          player: game.plies[explaining.ply - 1].color === 'w' ? meta.white : meta.black,
          move: moveName(game, explaining.ply - 1),
        })

  return (
    <div className="app">
      <header className="topbar">
        <h1>
          <span className="logo">♞</span>
          <span className="app-title"> Chess Analyzer</span>
        </h1>
        <div className="actions">
          <button
            className={view === 'puzzles' ? 'on' : ''}
            onClick={() => setView((v) => (v === 'puzzles' ? 'analyze' : 'puzzles'))}
            aria-label={t('Puzzles')}
          >
            🧩<span className="btn-label"> {t('Puzzles')}</span>
          </button>
          <button
            className={view === 'patterns' ? 'on' : ''}
            onClick={() => setView((v) => (v === 'patterns' ? 'analyze' : 'patterns'))}
            aria-label={t('My patterns')}
          >
            📊<span className="btn-label"> {t('Patterns')}</span>
          </button>
          <button onClick={() => setOrientation((o) => (o === 'white' ? 'black' : 'white'))} title={t('Flip board (f)')} aria-label={t('Flip board')}>
            ⇅<span className="btn-label"> {t('Flip')}</span>
          </button>
          <button className={showImport ? 'on' : ''} onClick={() => setShowImport((s) => !s)} aria-label={t('Load game')}>
            ＋<span className="btn-label"> {t('Load game')}</span>
          </button>
          <button
            className="lang-btn"
            onClick={() => setLang(lang === 'sv' ? 'en' : 'sv')}
            title={lang === 'sv' ? 'Switch to English' : 'Byt till svenska'}
            aria-label={lang === 'sv' ? 'Switch to English' : 'Byt till svenska'}
          >
            {lang === 'sv' ? 'EN' : 'SV'}
          </button>
        </div>
      </header>

      {/* Kept mounted while hidden so a running batch review keeps going */}
      <div className="patterns-wrap" hidden={view !== 'patterns'}>
        <PatternsView onOpen={openReviewed} />
      </div>

      {view === 'puzzles' && (
        <PuzzleView
          onOpenGame={(key, atPly, me) => void getStoredGame(key).then((g) => g && openReviewed(g, atPly, me))}
          onGoToPatterns={() => setView('patterns')}
        />
      )}

      <main className="layout" hidden={view !== 'analyze'}>
        <section className="board-col">
          {player(top)}
          <div className={`board-row ${inLine ? 'off-game' : ''}`} ref={boardRef}>
            <EvalBar score={play ? null : shownScore} orientation={orientation} />
            <Board
              fen={fen}
              orientation={orientation}
              lastMove={lastMove}
              shapes={shapes}
              onMove={onBoardMove}
              interactive={!play || (playAtEnd && fen.split(' ')[1] !== play.bot)}
            />
          </div>
          {player(top === 'w' ? 'b' : 'w')}

          {/* Right under the board, above the banners that come and go, so the buttons don't move while stepping */}
          <nav className="nav">
            <button onClick={() => (inLine || play ? setVariation([]) : goTo(0))} aria-label={t('Start')}>⏮</button>
            <button onClick={() => step(-1)} aria-label={t('Back')} disabled={!canStepBack}>◀</button>
            <button onClick={() => step(1)} aria-label={t('Forward')} disabled={!canStepForward}>▶</button>
            <button onClick={() => (inLine || play ? setVariation(plan) : goTo(game.plies.length))} aria-label={t('End')}>⏭</button>
          </nav>

          {mateIn !== null && !gameOver && !play && (
            <div className={`mate-banner ${mateIn > 0 ? 'w' : 'b'}`}>
              <div className="mate-text">
                <div className="mate-title">
                  ♚ {t('{side} has mate in {n}', { side: t(mateIn > 0 ? 'White' : 'Black'), n: Math.abs(mateIn) })}
                </div>
                {mateLine.length > 0 && <div className="mate-line">{formatLine(fen, mateLine, mateLine.length)}</div>}
              </div>
              {mateLine.length > 0 && !inMateLine && (
                <button onClick={showMate}>▶ {t('Show mate')}</button>
              )}
            </div>
          )}

          {inLine && (
            <LineBanner
              title={lineTitle}
              note={
                play
                  ? undefined
                  : explaining
                  ? explaining.kind === 'why'
                    ? explanation?.text
                    : explanation?.bestText
                  : varExplainOn
                    ? varExplain!.kind === 'why'
                      ? sideVerdict?.explanation?.text
                      : sideVerdict?.explanation?.bestText
                    : undefined
              }
              kind={explaining?.kind ?? (varExplainOn ? varExplain!.kind : 'line')}
              fen={mainFen}
              moves={plan}
              current={variation.length}
              onSelect={(n) => setVariation(plan.slice(0, n))}
              onExit={exitLine}
            />
          )}

          <EvalGraph
            evals={review?.evals ?? partialEvals}
            total={game.plies.length + 1}
            review={review}
            ply={ply}
            onSelect={navTo}
          />
        </section>

        <aside className="side-col">
          {showImport && <ImportPanel onLoad={loadPgn} />}
          {error && <p className="error">{error}</p>}
          {engineError && (
            <div className="card error-card">
              <strong>{t('Engine problem.')}</strong> {engineError}
              <div className="muted">
                {self.crossOriginIsolated ? t('Page is cross-origin isolated') : t('Page is not cross-origin isolated')} ·{' '}
                {navigator.userAgent}
              </div>
              <button onClick={() => location.reload()}>{t('Reload')}</button>
            </div>
          )}

          {progress && (
            <div className="card progress">
              <div className="muted">
                {t('Reviewing game… {done}/{total}', { done: progress.done, total: progress.total })}
              </div>
              <div className="bar">
                <div style={{ width: `${(progress.done / progress.total) * 100}%` }} />
              </div>
            </div>
          )}

          {play && <PlayCard play={play} fen={playEndFen} atEnd={playAtEnd} onResume={() => setVariation(plan)} onStop={() => setPlay(null)} />}

          {!play && isBookMove && verdictPly && (
            <div className="card verdict lbl-book">
              <strong>{moveName(game, verdictPly - 1)}</strong> <span className="glyph">📖</span> — {t('Book move')}
              {bookNow?.openingAt[verdictPly] && <span className="muted"> · {bookNow.openingAt[verdictPly]!.name}</span>}
            </div>
          )}

          {!play && varIsBook && !explaining && (
            <div className="card verdict lbl-book">
              <strong>
                {(() => {
                  const [, side, , , , n] = varLine[varLine.length - 1].fen.split(' ')
                  return side === 'b' ? `${n}.` : `${+n - 1}...`
                })()}{' '}
                {varLine[varLine.length - 1].san}
              </strong> <span className="glyph">📖</span> — {t('Book move')}
              {varBook.openingAt[varLine.length - 1] && <span className="muted"> · {varBook.openingAt[varLine.length - 1]!.name}</span>}
            </div>
          )}

          {!play && card && (
            <div className={`card verdict lbl-${card.brilliant ? 'brilliant' : card.great ? 'great' : card.rv.label}`}>
              <div>
                <strong>
                  <span className="move-no">{card.num}</span> {card.san}
                  {card.brilliant ? (
                    <span className="glyph"> !!</span>
                  ) : card.great ? (
                    <span className="glyph"> !</span>
                  ) : (
                    GLYPH[card.rv.label] && <span className="glyph"> {GLYPH[card.rv.label]}</span>
                  )}
                </strong>{' '}
                — {card.brilliant ? t('Brilliant move') : card.great ? t('Great move') : t(LABEL_TEXT[card.rv.label])}
                {!card.explanation && card.rv.label === 'good' && card.rv.bestSan && (
                  <span className="muted"> · {t('best was {move}', { move: card.rv.bestSan })}</span>
                )}
              </div>
              {card.great && !card.brilliant && <GreatNote great={card.great} />}
              {!card.explanation && card.note && <p className="why">{card.note}</p>}
              {card.explanation && (
                <>
                  <p className="why">{card.explanation.text}</p>
                  <div className="row">
                    {card.explanation.refutation.length > 0 && (
                      <button className={card.kind === 'why' ? 'on' : ''} onClick={() => card.show('why')}>
                        ▶ {t('Show why')}
                      </button>
                    )}
                    {card.explanation.best.length > 0 && (
                      <button className={card.kind === 'best' ? 'on' : ''} onClick={() => card.show('best')}>
                        ★ {t('Show best')}
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
          )}

          {!play && sidePending && (
            <div className="card verdict">
              <strong>{sideVerdict!.ply.san}</strong>{' '}
              <span className="muted">
                — {liveMode === 'off' ? t('turn on live analysis to judge moves in side lines') : t('checking the move…')}
              </span>
            </div>
          )}

          {!play && (
          <div className="card engine">
            <div className="engine-head">
              <span className="muted">
                {gameOver
                  ? t('Game over')
                  : liveMode === 'off'
                    ? fromReview
                      ? t('Live analysis off · best line from the review')
                      : t('Live analysis off')
                    : !liveActive
                      ? fromReview
                        ? t('Paused · best line from the review')
                        : t('Paused')
                      : fromReview
                        ? t('Best line from the review · engine starting…')
                        : liveLines[0]
                          ? t('Stockfish 19 · depth {depth}', { depth: liveLines[0].depth })
                          : t('Engine thinking…')}
              </span>
              <span className="seg" role="group" aria-label={t('Live engine')}>
                <button className={liveMode === 'off' ? 'on' : ''} onClick={() => setLiveMode('off')} title={t('No live analysis (saves power)')}>
                  {t('Off')}
                </button>
                <button className={liveMode === 'lite' ? 'on' : ''} onClick={() => setLiveMode('lite')} title={t('Small network, instant')}>
                  Lite
                </button>
                <button
                  className={liveMode === 'full' ? 'on' : ''}
                  onClick={() => setLiveMode('full')}
                  title={t('Full Stockfish 19 network (~99 MB download once), multi-threaded')}
                >
                  Full
                </button>
              </span>
            </div>
            {liveLines.length > 0 && <EngineLines fen={fen} lines={liveLines} labels={liveLabels} onPlay={onEngineLine} bookMoves={lineBookMoves} />}
            <PositionChat context={positionContext} />
            {!gameOver && (
              <div className="play-on">
                <PlaySetup key={`${game.startFen}|${pgn}`} defaultSide={mySide(game, orientation)} player={playerInfo} onStart={startPlay} />
              </div>
            )}
          </div>
          )}

          {game.plies.length > 0 && (
            <div className="panel">
              <div className="tabs panel-tabs">
                <button className={tab === 'summary' ? 'on' : ''} onClick={() => setTab('summary')} disabled={!review}>
                  {t('Summary')}
                </button>
                <button className={tab === 'moves' ? 'on' : ''} onClick={() => setTab('moves')}>
                  {t('Moves')}
                </button>
              </div>
              {tab === 'summary' && review ? (
                <SummaryCard game={game} review={review} onSelect={navTo} deep={deep} onDeep={startDeep} book={bookNow} pgn={pgn} side={mySide(game, orientation)} brilliant={brilliant} great={great} />
              ) : (
                <MoveList game={game} review={review} ply={inLine ? -1 : ply} onSelect={navTo} bookPlies={bookPlies} brilliant={brilliant} great={great} />
              )}
            </div>
          )}
        </aside>
      </main>
    </div>
  )
}
