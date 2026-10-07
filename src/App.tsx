import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Chess, DEFAULT_POSITION } from 'chess.js'
import type { DrawShape } from 'chessground/draw'
import type { Key } from 'chessground/types'
import { availableThreads, Engine, type EngineFlavor, type EngineLine } from './engine'
import { GLYPH, lineCost, lineLabels, parseGame, rateReview, REVIEW_LIMITS, reviewGame, type Game, type Label, type PositionEval, type Review } from './analysis'
import { explainMove, moveName } from './explain'
import { Board } from './components/Board'
import { EvalBar } from './components/EvalBar'
import { EvalGraph } from './components/EvalGraph'
import { MoveList } from './components/MoveList'
import { ImportPanel } from './components/ImportPanel'
import { EngineLines } from './components/EngineLines'
import { SummaryCard, type DeepState } from './components/SummaryCard'
import { restoreSession, saveSession } from './session'
import { LineBanner } from './components/LineBanner'
import { PatternsView } from './components/PatternsView'
import { PuzzleView } from './components/PuzzleView'
import { getStoredGame, type StoredGame } from './store'

const DEEP_LIMITS = { depth: 22, movetimeMs: 3000 } // full engine; the time cap keeps hard positions bounded
const LIVE_DEPTH = { lite: 20, full: 24 }
const LIVE_LINES = 3
const EXPLAIN_PLIES = 8
const LIVE_FLAVOR_KEY = 'chess-analyzer:live-engine'

function savedLiveFlavor(): EngineFlavor {
  try {
    return localStorage.getItem(LIVE_FLAVOR_KEY) === 'full' ? 'full' : 'lite'
  } catch {
    return 'lite'
  }
}

const LABEL_TEXT: Record<Label, string> = {
  best: 'Best move',
  good: 'Good move',
  inaccuracy: 'Inaccuracy',
  mistake: 'Mistake',
  blunder: 'Blunder',
}

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

export default function App() {
  const [restored] = useState(restoreSession) // read once, on first render
  const [pgn, setPgn] = useState(restored?.pgn ?? '')
  const [game, setGame] = useState<Game>(() => restored?.game ?? emptyGame())
  const [ply, setPly] = useState(restored?.ply ?? 0)
  const [variation, setVariation] = useState<string[]>([]) // UCI moves branching off the mainline at `ply`
  const [plan, setPlan] = useState<string[]>([]) // the full side line `variation` is a prefix of (for stepping forward)
  const [explaining, setExplaining] = useState<Explaining | null>(null)
  const [orientation, setOrientation] = useState<'white' | 'black'>(restored?.orientation ?? 'white')
  const [review, setReview] = useState<Review | null>(restored?.review ?? null)
  const [partialEvals, setPartialEvals] = useState<PositionEval[]>([])
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [live, setLive] = useState<{ fen: string; lines: EngineLine[] } | null>(null)
  const [showImport, setShowImport] = useState(!restored)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<'summary' | 'moves'>(restored?.review ? restored.tab : 'moves')
  const [view, setView] = useState<'analyze' | 'patterns' | 'puzzles'>('analyze')
  const [deep, setDeep] = useState<DeepState>(restored?.deepDone ? { ...emptyDeep, status: 'done' } : emptyDeep)
  const [liveFlavor, setLiveFlavor] = useState<EngineFlavor>(savedLiveFlavor)
  const [engineError, setEngineError] = useState<string | null>(null)

  const liveEngine = useRef<Engine | null>(null)
  const reviewEngine = useRef<Engine | null>(null)
  const deepEngine = useRef<Engine | null>(null)
  const reviewToken = useRef(0)

  useEffect(() => {
    reviewEngine.current = new Engine({ onError: (m) => setEngineError(`Review engine failed to start: ${m}`) })
    return () => {
      reviewEngine.current?.terminate()
      deepEngine.current?.terminate()
    }
  }, [])

  useEffect(() => {
    const onError = (m: string) => setEngineError(`${liveFlavor === 'full' ? 'Full' : 'Lite'} engine failed to start: ${m}`)
    const engine =
      liveFlavor === 'full'
        ? new Engine({ multiPv: LIVE_LINES, flavor: 'full', threads: availableThreads(), hashMb: 64, onError })
        : new Engine({ multiPv: LIVE_LINES, onError })
    liveEngine.current = engine
    try {
      localStorage.setItem(LIVE_FLAVOR_KEY, liveFlavor)
    } catch {
      /* storage unavailable */
    }
    return () => engine.terminate()
  }, [liveFlavor])

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
      onError: (m) => setEngineError(`Deep analysis engine failed to start: ${m}`),
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
        setError(`Could not read that PGN: ${e instanceof Error ? e.message : e}`)
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

  // --- Live engine ---------------------------------------------------------

  useEffect(() => {
    const engine = liveEngine.current
    if (!engine) return
    engine.stop()
    if (gameOver) return
    const t = setTimeout(() => {
      void engine.analyze(fen, { depth: LIVE_DEPTH[liveFlavor] }, (lines) => setLive({ fen, lines }))
    }, 120)
    return () => clearTimeout(t)
  }, [fen, gameOver, liveFlavor])

  const reviewedEval = !inVariation ? (review?.evals[ply] ?? partialEvals[ply]) : undefined
  const liveLines = useMemo(() => (live?.fen === fen ? live.lines : []), [live, fen])
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
  const step = useCallback(
    (d: number) => {
      if (plan.length) {
        if (d > 0 && variation.length < plan.length) setVariation(plan.slice(0, variation.length + 1))
        else if (d < 0 && variation.length) setVariation(variation.slice(0, -1))
        return
      }
      goTo(ply + d)
    },
    [plan, variation, goTo, ply],
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
      if (!plan.length && game.plies[ply]?.uci === uci) {
        setPly(ply + 1)
        return
      }
      const next = [...variation, uci]
      setVariation(next)
      if (plan[variation.length] !== uci) {
        setPlan(next)
        setExplaining(null)
      }
    },
    [variation, plan, game.plies, ply],
  )

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
      else if (e.key === 'Home' || e.key === 'ArrowUp') goTo(0)
      else if (e.key === 'End' || e.key === 'ArrowDown') goTo(game.plies.length)
      else if (e.key === 'f') setOrientation((o) => (o === 'white' ? 'black' : 'white'))
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [step, goTo, game.plies.length])

  // --- Move verdict & explanation ------------------------------------------

  const verdictPly = explaining ? explaining.ply : !inVariation && ply > 0 ? ply : null
  const verdict = verdictPly && review ? review.moves[verdictPly - 1] : undefined
  const explanation = useMemo(
    () => (verdictPly && review ? explainMove(game, review, verdictPly - 1) : null),
    [game, review, verdictPly],
  )

  const showExplanation = (kind: Explaining['kind']) => {
    if (!verdictPly || !explanation) return
    setExplaining({ ply: verdictPly, kind })
    if (kind === 'why') enterLine(verdictPly, explanation.refutation.slice(0, EXPLAIN_PLIES))
    else enterLine(verdictPly - 1, explanation.best.slice(0, EXPLAIN_PLIES))
  }

  // --- Board annotations ---------------------------------------------------

  const shapes = useMemo(() => {
    const out: DrawShape[] = []
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
    if (verdict && !inVariation && verdictPly === ply) {
      const played = game.plies[ply - 1]
      const glyph = GLYPH[verdict.label]
      if (glyph) out.push({ orig: played.uci.slice(2, 4) as Key, label: { text: glyph, fill: LABEL_COLOR[verdict.label] } })
    }
    return out
  }, [liveLines, liveLabels, fen, verdict, verdictPly, inVariation, game.plies, ply])

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
            title={`Estimated rating for this game, compared with ${review.rating[c].basis} players${review.rating[c].reliable ? '' : ' (game too short to be reliable)'}${review.rating[c].precision === 'rough' ? ' (rough: single fast games vary a lot)' : ''}`}
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
  const canStepForward = inLine ? variation.length < plan.length : ply < game.plies.length
  const canStepBack = inLine ? variation.length > 0 : ply > 0
  const exitLine = () => goTo(explaining ? explaining.ply : ply)
  const lineTitle = !explaining
    ? 'Alternate line'
    : explaining.kind === 'why'
      ? `${moveName(game, explaining.ply - 1)}: how ${game.plies[explaining.ply - 1].color === 'w' ? meta.black : meta.white} can punish it`
      : `What ${game.plies[explaining.ply - 1].color === 'w' ? meta.white : meta.black} could have played instead of ${moveName(game, explaining.ply - 1)}`

  return (
    <div className="app">
      <header className="topbar">
        <h1>
          <span className="logo">♞</span> Chess Analyzer
        </h1>
        <div className="actions">
          <button
            className={view === 'puzzles' ? 'on' : ''}
            onClick={() => setView((v) => (v === 'puzzles' ? 'analyze' : 'puzzles'))}
            aria-label="Puzzles"
          >
            🧩<span className="btn-label"> Puzzles</span>
          </button>
          <button
            className={view === 'patterns' ? 'on' : ''}
            onClick={() => setView((v) => (v === 'patterns' ? 'analyze' : 'patterns'))}
            aria-label="My patterns"
          >
            📊<span className="btn-label"> Patterns</span>
          </button>
          <button onClick={() => setOrientation((o) => (o === 'white' ? 'black' : 'white'))} title="Flip board (f)" aria-label="Flip board">
            ⇅<span className="btn-label"> Flip</span>
          </button>
          <button className={showImport ? 'on' : ''} onClick={() => setShowImport((s) => !s)} aria-label="Load game">
            ＋<span className="btn-label"> Load game</span>
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
          <div className={`board-row ${inLine ? 'off-game' : ''}`}>
            <EvalBar score={shownScore} orientation={orientation} />
            <Board fen={fen} orientation={orientation} lastMove={lastMove} shapes={shapes} onMove={onBoardMove} />
          </div>
          {player(top === 'w' ? 'b' : 'w')}

          {inLine && (
            <LineBanner
              title={lineTitle}
              note={!explaining ? undefined : explaining.kind === 'why' ? explanation?.text : explanation?.bestText}
              kind={explaining?.kind ?? 'line'}
              fen={mainFen}
              moves={plan}
              current={variation.length}
              onSelect={(n) => setVariation(plan.slice(0, n))}
              onExit={exitLine}
            />
          )}

          <nav className="nav">
            <button onClick={() => (inLine ? setVariation([]) : goTo(0))} aria-label="Start">⏮</button>
            <button onClick={() => step(-1)} aria-label="Back" disabled={!canStepBack}>◀</button>
            <button onClick={() => step(1)} aria-label="Forward" disabled={!canStepForward}>▶</button>
            <button onClick={() => (inLine ? setVariation(plan) : goTo(game.plies.length))} aria-label="End">⏭</button>
          </nav>

          <EvalGraph
            evals={review?.evals ?? partialEvals}
            total={game.plies.length + 1}
            review={review}
            ply={ply}
            onSelect={goTo}
          />
        </section>

        <aside className="side-col">
          {showImport && <ImportPanel onLoad={loadPgn} />}
          {error && <p className="error">{error}</p>}
          {engineError && (
            <div className="card error-card">
              <strong>Engine problem.</strong> {engineError}
              <div className="muted">
                {self.crossOriginIsolated ? 'Page is cross-origin isolated' : 'Page is not cross-origin isolated'} ·{' '}
                {navigator.userAgent}
              </div>
              <button onClick={() => location.reload()}>Reload</button>
            </div>
          )}

          {progress && (
            <div className="card progress">
              <div className="muted">
                Reviewing game… {progress.done}/{progress.total}
              </div>
              <div className="bar">
                <div style={{ width: `${(progress.done / progress.total) * 100}%` }} />
              </div>
            </div>
          )}

          {verdict && verdictPly && (
            <div className={`card verdict lbl-${verdict.label}`}>
              <div>
                <strong>
                  {game.plies[verdictPly - 1].san}
                  {GLYPH[verdict.label] && <span className="glyph"> {GLYPH[verdict.label]}</span>}
                </strong>{' '}
                — {LABEL_TEXT[verdict.label]}
                {!explanation && verdict.label === 'good' && verdict.bestSan && (
                  <span className="muted"> · best was {verdict.bestSan}</span>
                )}
              </div>
              {explanation && (
                <>
                  <p className="why">{explanation.text}</p>
                  <div className="row">
                    {explanation.refutation.length > 0 && (
                      <button className={explaining?.kind === 'why' ? 'on' : ''} onClick={() => showExplanation('why')}>
                        ▶ Show why
                      </button>
                    )}
                    {explanation.best.length > 0 && (
                      <button className={explaining?.kind === 'best' ? 'on' : ''} onClick={() => showExplanation('best')}>
                        ★ Show best
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
          )}

          <div className="card engine">
            <div className="engine-head">
              <span className="muted">
                {gameOver ? 'Game over' : liveLines[0] ? `Stockfish 19 · depth ${liveLines[0].depth}` : 'Engine thinking…'}
              </span>
              <span className="seg" role="group" aria-label="Live engine">
                <button className={liveFlavor === 'lite' ? 'on' : ''} onClick={() => setLiveFlavor('lite')} title="Small network, instant">
                  Lite
                </button>
                <button
                  className={liveFlavor === 'full' ? 'on' : ''}
                  onClick={() => setLiveFlavor('full')}
                  title="Full Stockfish 19 network (~99 MB download once), multi-threaded"
                >
                  Full
                </button>
              </span>
            </div>
            {liveLines.length > 0 && <EngineLines fen={fen} lines={liveLines} labels={liveLabels} onPlay={onEngineLine} />}
          </div>

          {game.plies.length > 0 && (
            <div className="panel">
              <div className="tabs panel-tabs">
                <button className={tab === 'summary' ? 'on' : ''} onClick={() => setTab('summary')} disabled={!review}>
                  Summary
                </button>
                <button className={tab === 'moves' ? 'on' : ''} onClick={() => setTab('moves')}>
                  Moves
                </button>
              </div>
              {tab === 'summary' && review ? (
                <SummaryCard game={game} review={review} onSelect={goTo} deep={deep} onDeep={startDeep} />
              ) : (
                <MoveList game={game} review={review} ply={inLine ? -1 : ply} onSelect={goTo} />
              )}
            </div>
          )}
        </aside>
      </main>
    </div>
  )
}
