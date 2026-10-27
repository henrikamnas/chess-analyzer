import { Chess } from 'chess.js'
import type { Commentary, MoveComment, Text } from '../commentary'
import type { Game } from '../analysis'
import { t, useLang } from '../i18n'

interface Props {
  commentary: Commentary
  game: Game
  ply: number // position in the game: 0 = start, i = after move i
  ai?: boolean // commentary pasted in from the user's AI chat rather than the app's own
  /** Shows a line on the board: the moves (UCI) played from the position after `fromPly` moves. */
  onShowLine: (fromPly: number, moves: string[]) => void
}

/** The commentary at the current move: the introduction at the start, the summary at the end. */
export function CommentaryCard({ commentary, game, ply, ai, onShowLine }: Props) {
  const lang = useLang() === 'sv' ? 'sv' : 'en'
  const comments = ply > 0 ? commentary.comments.filter((c) => c.ply === ply - 1) : []
  const intro = ply === 0 && commentary.intro[lang]
  const summary = ply === game.plies.length && commentary.summary[lang]
  if (!intro && !comments.length && !summary) return null
  const icon = ai ? '🤖' : '💬'

  const show = (line: NonNullable<MoveComment['line']>) => {
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
      {intro && (
        <p>
          {ai ? icon : '📜'} {intro}
          <Unchecked text={commentary.intro} />
        </p>
      )}
      {comments.map((comment, k) => (
        <div key={k}>
          <p>
            {icon} {comment[lang]}
            <Unchecked text={comment} />
          </p>
          {comment.line && (
            <div className="row">
              <button onClick={() => show(comment.line!)}>▶ {comment.line.from === 'before' ? t('Show the alternative') : t('Show what follows')}</button>
              {comment.line.own && <span className="muted own-line">{t('The AI’s own line, not checked by the engine')}</span>}
            </div>
          )}
        </div>
      ))}
      {summary && (
        <p>
          {ai ? icon : '📜'} <strong>{t('Summary')}:</strong> {summary}
          <Unchecked text={commentary.summary} />
        </p>
      )}
    </div>
  )
}

/** Moves the AI mentions that the engine's lines don't back up. */
function Unchecked({ text }: { text: Text }) {
  if (!text.unchecked?.length) return null
  return (
    <span className="unchecked" title={t("The engine's lines don't include these moves, so this part may be wrong.")}>
      {' '}
      ⚠ {t('Not checked by the engine: {moves}', { moves: text.unchecked.join(', ') })}
    </span>
  )
}
