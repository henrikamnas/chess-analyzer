// Thin wrapper around a Stockfish web worker speaking UCI.
// Scores are always normalized to White's point of view.

export type Score = { cp: number; mate?: undefined } | { mate: number; cp?: undefined }

export interface EngineLine {
  multipv: number // 1 = best line
  depth: number
  score: Score
  pv: string[] // UCI moves
}

export interface EngineResult extends EngineLine {
  bestMove: string | null
}

export type EngineFlavor = 'lite' | 'full'

export interface EngineOptions {
  multiPv?: number
  flavor?: EngineFlavor // 'lite': small network, fast to load; 'full': full network, ~99 MB download
  threads?: number // only used by the full multi-threaded build
  hashMb?: number
}

/** Threads to give a full engine, leaving a core for the UI. */
export function availableThreads() {
  return Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 2) - 1))
}

/** Search limits: stop at `depth`, or after `movetimeMs` if given, whichever comes first. */
export interface Limits {
  depth: number
  movetimeMs?: number
}

interface Job {
  fen: string
  limits: Limits
  onInfo?: (lines: EngineLine[]) => void
  resolve: (r: EngineResult) => void
  cancelled: boolean
  lines: EngineLine[] // latest line per multipv slot
}

export class Engine {
  private worker: Worker
  private ready: Promise<void>
  private current: Job | null = null
  private queue: Job[] = []

  readonly flavor: EngineFlavor

  constructor({ multiPv = 1, flavor = 'lite', threads = 1, hashMb = 16 }: EngineOptions = {}) {
    // The multi-threaded full build needs SharedArrayBuffer, i.e. a cross-origin isolated page.
    const multiThreaded = flavor === 'full' && self.crossOriginIsolated
    this.flavor = flavor
    const file = flavor === 'lite' ? 'stockfish' : multiThreaded ? 'stockfish-full' : 'stockfish-full-single'
    this.worker = new Worker(`/engine/${file}.js`)
    this.ready = new Promise((resolve) => {
      const onReady = (e: MessageEvent<string>) => {
        if (e.data === 'uciok') {
          this.worker.removeEventListener('message', onReady)
          if (multiThreaded && threads > 1) this.worker.postMessage(`setoption name Threads value ${threads}`)
          if (hashMb !== 16) this.worker.postMessage(`setoption name Hash value ${hashMb}`)
          if (multiPv > 1) this.worker.postMessage(`setoption name MultiPV value ${multiPv}`)
          resolve()
        }
      }
      this.worker.addEventListener('message', onReady)
    })
    this.worker.addEventListener('message', (e) => this.onLine(String(e.data)))
    this.worker.postMessage('uci')
  }

  /** Queue an analysis. Resolves with the best line when the engine reports its best move. */
  analyze(fen: string, limits: Limits, onInfo?: (lines: EngineLine[]) => void): Promise<EngineResult> {
    return new Promise((resolve) => {
      this.queue.push({ fen, limits, onInfo, resolve, cancelled: false, lines: [] })
      void this.next()
    })
  }

  /** Abort the running search and drop anything queued. Pending promises resolve with what they have. */
  stop() {
    for (const job of this.queue) {
      job.cancelled = true
      job.resolve({ multipv: 1, depth: 0, score: { cp: 0 }, pv: [], bestMove: null })
    }
    this.queue = []
    if (this.current) {
      this.current.cancelled = true
      this.worker.postMessage('stop')
    }
  }

  terminate() {
    this.stop()
    this.worker.terminate()
  }

  private async next() {
    if (this.current || this.queue.length === 0) return
    const job = this.queue.shift()!
    this.current = job
    await this.ready
    this.worker.postMessage(`position fen ${job.fen}`)
    const { depth, movetimeMs } = job.limits
    this.worker.postMessage(`go depth ${depth}${movetimeMs ? ` movetime ${movetimeMs}` : ''}`)
  }

  private onLine(line: string) {
    const job = this.current
    if (!job) return

    if (line.startsWith('info ') && line.includes(' score ') && !line.includes('bound')) {
      const parsed = parseInfo(line, job.fen)
      if (parsed && (parsed.pv.length > 0 || parsed.depth === 0)) {
        job.lines[parsed.multipv - 1] = parsed
        if (!job.cancelled) job.onInfo?.(job.lines.filter(Boolean))
      }
    } else if (line.startsWith('bestmove')) {
      const move = line.split(' ')[1]
      const last = job.lines[0] ?? { multipv: 1, depth: 0, score: { cp: 0 }, pv: [] }
      this.current = null
      job.resolve({ ...last, bestMove: move && move !== '(none)' ? move : null })
      void this.next()
    }
  }
}

function parseInfo(line: string, fen: string): EngineLine | null {
  const tokens = line.split(' ')
  const flip = fen.split(' ')[1] === 'b' ? -1 : 1
  let depth = 0
  let multipv = 1
  let score: Score | null = null
  let pv: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t === 'depth') depth = Number(tokens[i + 1])
    else if (t === 'multipv') multipv = Number(tokens[i + 1])
    else if (t === 'score') {
      const kind = tokens[i + 1]
      const value = Number(tokens[i + 2]) * flip
      score = kind === 'mate' ? { mate: value } : { cp: value }
    } else if (t === 'pv') {
      pv = tokens.slice(i + 1)
      break
    }
  }
  return score ? { multipv, depth, score, pv } : null
}
