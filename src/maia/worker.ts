// Runs Maia-1 off the main thread: loads a rating's network on first use and answers with the move
// probabilities for a position.
import { Chess } from 'chess.js'
import { encode, policyIndex } from './encode'
import { forward, loadNet, type Net } from './net'

export interface MaiaRequest {
  id: number
  rating: number
  history: string[] // FENs, oldest first; the last is the position to predict
}

export type MaiaResponse = { id: number; moves: { uci: string; p: number }[] } | { id: number; error: string }

const nets = new Map<number, Promise<Net>>()
const base = `${self.location.origin}${import.meta.env.BASE_URL}maia/`

function net(rating: number): Promise<Net> {
  let p = nets.get(rating)
  if (!p) {
    p = fetch(`${base}maia1-${rating}.bin`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.arrayBuffer()
      })
      .then(loadNet)
    nets.set(rating, p)
    p.catch(() => nets.delete(rating))
  }
  return p
}

self.onmessage = async (e: MessageEvent<MaiaRequest>) => {
  const { id, rating, history } = e.data
  try {
    const logits = forward(await net(rating), encode(history))
    const chess = new Chess(history[history.length - 1])
    const legal = chess.moves({ verbose: true })
    const ls = legal.map((m) => logits[policyIndex(m, chess.turn())])
    const max = Math.max(...ls)
    const ex = ls.map((l) => Math.exp(l - max))
    const sum = ex.reduce((a, b) => a + b, 0)
    const moves = legal.map((m, i) => ({ uci: m.from + m.to + (m.promotion ?? ''), p: ex[i] / sum })).sort((a, b) => b.p - a.p)
    self.postMessage({ id, moves } satisfies MaiaResponse)
  } catch (err) {
    self.postMessage({ id, error: err instanceof Error ? err.message : String(err) } satisfies MaiaResponse)
  }
}
