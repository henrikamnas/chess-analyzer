import { useEffect, useRef } from 'react'
import { Chessground } from 'chessground'
import type { Api } from 'chessground/api'
import type { DrawShape } from 'chessground/draw'
import type { Key } from 'chessground/types'
import { Chess, SQUARES } from 'chess.js'
import 'chessground/assets/chessground.base.css'
import 'chessground/assets/chessground.brown.css'
import 'chessground/assets/chessground.cburnett.css'

interface Props {
  fen: string
  orientation: 'white' | 'black'
  lastMove?: string // UCI
  shapes: DrawShape[]
  onMove: (uci: string) => void
}

function legalDests(chess: Chess) {
  const dests = new Map<Key, Key[]>()
  for (const sq of SQUARES) {
    const moves = chess.moves({ square: sq, verbose: true })
    if (moves.length) dests.set(sq, moves.map((m) => m.to))
  }
  return dests
}

export function Board({ fen, orientation, lastMove, shapes, onMove }: Props) {
  const el = useRef<HTMLDivElement>(null)
  const api = useRef<Api | null>(null)
  const onMoveRef = useRef(onMove)
  useEffect(() => {
    onMoveRef.current = onMove
  })

  useEffect(() => {
    api.current = Chessground(el.current!, {
      animation: { duration: 180 },
      highlight: { lastMove: true, check: true },
      drawable: { enabled: true },
      movable: { free: false, showDests: true },
    })
    return () => api.current?.destroy()
  }, [])

  useEffect(() => {
    const chess = new Chess(fen)
    const turn = chess.turn() === 'w' ? 'white' : 'black'
    api.current?.set({
      fen,
      orientation,
      turnColor: turn,
      check: chess.inCheck(),
      lastMove: lastMove ? [lastMove.slice(0, 2) as Key, lastMove.slice(2, 4) as Key] : undefined,
      movable: {
        color: turn,
        dests: legalDests(chess),
        events: {
          after: (orig, dest) => {
            const piece = chess.get(orig as never)
            const promo = piece?.type === 'p' && (dest[1] === '8' || dest[1] === '1') ? 'q' : ''
            onMoveRef.current(orig + dest + promo)
          },
        },
      },
    })
  }, [fen, orientation, lastMove])

  useEffect(() => {
    api.current?.setAutoShapes(shapes)
  }, [shapes])

  return <div ref={el} className="cg-board-wrap" />
}
