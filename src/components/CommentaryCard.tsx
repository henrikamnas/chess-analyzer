import { Chess } from 'chess.js'
import type { Commentary } from '../commentary'
import type { Game } from '../analysis'
import { t, useLang } from '../i18n'

interface Props {
  commentary: Commentary
  game: Game
  ply: number // position in the game: 0 = start, i = after move i
  /** Shows a line on the board: the moves (UCI) played from the position after `fromPly` moves. */
  onShowLine: (fromPly: number, moves: string[]) => void
}

/** The commentary at the current move of a famous game: the introduction at the start, the summary at the end. */
export function CommentaryCard({ commentary, game, ply, onShowLine }: Props) {
  const lang = useLang() === 'sv' ? 'sv' : 'en'
  const comment = ply > 0 ? commentary.comments.find((c) => c.ply === ply - 1) : undefined
  const atEnd = ply === game.plies.length
  if (ply > 0 && !comment && !atEnd) return null

  const show = () => {
    const line = comment!.line!
    const fromPly = line.from === 'before' ? ply - 1 : ply
    const chess = new Chess(fromPly === 0 ? game.startFen : game.plies[fromPly - 1].fenAfter)
    const moves: string[] = []
    for (const san of line.san) {
      const m = chess.move(san)
      moves.push(m.from + m.to + (m.promotion ?? ''))
    }
    onShowLine(fromPly, moves)
  }

  return (
    <div className="card commentary">
      {ply === 0 && <p>📜 {commentary.intro[lang]}</p>}
      {comment && (
        <>
          <p>💬 {comment[lang]}</p>
          {comment.line && (
            <div className="row">
              <button onClick={show}>▶ {comment.line.from === 'before' ? t('Show the alternative') : t('Show what follows')}</button>
            </div>
          )}
        </>
      )}
      {atEnd && (
        <p>
          📜 <strong>{t('Summary')}:</strong> {commentary.summary[lang]}
        </p>
      )}
    </div>
  )
}
