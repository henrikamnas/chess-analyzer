import { useState } from 'react'
import type { Game, Review } from '../analysis'
import { buildAiPrompt, type Side } from '../aiPrompt'
import { parseAiCommentary, saveAiCommentary, useAiCommentary, type ImportReport } from '../aiCommentary'
import { t, tn } from '../i18n'
import type { BookInfo } from '../openings'
import type { GreatMove } from '../greatMoves'

interface Props {
  game: Game
  review: Review
  book: BookInfo | null
  pgn: string
  defaultSide: Side
  brilliant: Set<number>
  great: Map<number, GreatMove>
}

// Opened in a new tab after copying; the user pastes the prompt there (the prompt is too long for URL prefill).
const CHATS = [
  { name: 'Claude', url: 'https://claude.ai/new' },
  { name: 'ChatGPT', url: 'https://chatgpt.com/' },
  { name: 'Gemini', url: 'https://gemini.google.com/app' },
]

type Mode = 'review' | 'commentary'

/**
 * Copies the game and its engine review as a prompt for any chat LLM, using the user's own subscription: either
 * for a short review to read there, or for move-by-move commentary to paste back and step through here.
 */
export function AskAi({ game, review, book, pgn, defaultSide, brilliant, great }: Props) {
  const [side, setSide] = useState<Side>(defaultSide)
  const [status, setStatus] = useState<{ mode: Mode; state: 'copied' | 'failed' } | null>(null)
  const [fallback, setFallback] = useState<string | null>(null)
  const [answer, setAnswer] = useState('')
  const [result, setResult] = useState<{ report: ImportReport } | { error: string } | null>(null)
  const commentary = useAiCommentary(game)

  const copy = async (mode: Mode) => {
    const prompt = buildAiPrompt(game, review, book, side, pgn, brilliant, great, mode)
    try {
      await navigator.clipboard.writeText(prompt)
      setStatus({ mode, state: 'copied' })
      setFallback(null)
    } catch {
      // No clipboard access (e.g. plain http on another device): show the text to copy by hand
      setStatus({ mode, state: 'failed' })
      setFallback(prompt)
    }
  }

  const load = () => {
    const r = parseAiCommentary(answer, game, review)
    if ('error' in r) return setResult(r)
    saveAiCommentary(game, r.commentary)
    setResult({ report: r.report })
    setAnswer('')
  }

  const copied = (mode: Mode) =>
    status?.mode === mode && (
      <>
        {status.state === 'copied' && (
          <div className="ask-ai-row">
            <span>✓ {t('Copied. Paste it into:')}</span>
            {CHATS.map((c) => (
              <a key={c.name} href={c.url} target="_blank" rel="noreferrer">
                {c.name}
              </a>
            ))}
          </div>
        )}
        {status.state === 'failed' && fallback && (
          <>
            <div className="muted">{t('Could not copy automatically. Select the text below and copy it:')}</div>
            <textarea className="ask-ai-text" readOnly value={fallback} onFocus={(e) => e.currentTarget.select()} />
          </>
        )}
      </>
    )

  return (
    <div className="ask-ai">
      <h3>{t('Ask an AI')}</h3>
      <p className="muted">{t('Copies the game and the engine review as a prompt you can paste into Claude, ChatGPT or any other AI chat.')}</p>
      <div className="ask-ai-row">
        <label>
          {t('I played')}{' '}
          <select value={side ?? ''} onChange={(e) => setSide((e.target.value || null) as Side)}>
            <option value="w">{t('White')}</option>
            <option value="b">{t('Black')}</option>
            <option value="">{t('Neither')}</option>
          </select>
        </label>
        <button className="primary" onClick={() => copy('review')}>
          📋 {t('Copy for AI')}
        </button>
      </div>
      {copied('review')}

      {!game.meta.famousId && (
        <>
          <h3>{t('AI commentary')}</h3>
          <p className="muted">
            {t('Move-by-move commentary you can step through, written by your AI chat: copy the prompt, paste it into the chat, then paste its answer back here.')}
          </p>
          {commentary && (
            <div className="ask-ai-row">
              <span>
                ✓ {tn('This game has AI commentary on {n} move.', 'This game has AI commentary on {n} moves.', new Set(commentary.comments.map((c) => c.ply)).size)}{' '}
                {t('Step through the game to read it.')}
              </span>
              <button
                onClick={() => {
                  saveAiCommentary(game, null)
                  setResult(null)
                }}
              >
                {t('Remove')}
              </button>
            </div>
          )}
          <div className="ask-ai-row">
            <button onClick={() => copy('commentary')}>📋 {t('Copy commentary prompt')}</button>
          </div>
          {copied('commentary')}
          <textarea
            className="ask-ai-text ask-ai-answer"
            placeholder={t("Paste the AI's answer here")}
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
          />
          <div className="ask-ai-row">
            <button className="primary" disabled={!answer.trim()} onClick={load}>
              {t('Load commentary')}
            </button>
          </div>
          {result && 'error' in result && (
            <div className="ask-ai-row warn">
              {result.error === 'no-json'
                ? t("Couldn't find the commentary in the answer. Paste the AI's whole answer, including the part between the ``` marks.")
                : result.error === 'other-game'
                  ? t('Most of the moves in the answer are not in this game. Paste it into the same game you copied the prompt from.')
                  : t('The answer has no comments on moves of this game.')}
            </div>
          )}
          {result && 'report' in result && <ReportView report={result.report} />}
        </>
      )}
    </div>
  )
}

function ReportView({ report }: { report: ImportReport }) {
  const notes = [
    report.skipped.length > 0 &&
      tn('{n} comment skipped: its move ({moves}) is not in this game.', '{n} comments skipped: their moves ({moves}) are not in this game.', report.skipped.length, {
        moves: report.skipped.join(', '),
      }),
    report.linesOwn > 0 && tn('{n} line is the AI’s own, not the engine’s; it is labelled.', '{n} lines are the AI’s own, not the engine’s; they are labelled.', report.linesOwn),
    report.linesDropped > 0 && tn('{n} line removed: its first move is not legal.', '{n} lines removed: their first move is not legal.', report.linesDropped),
    report.linesShortened > 0 && tn('{n} line cut short at an illegal move.', '{n} lines cut short at an illegal move.', report.linesShortened),
    report.unchecked > 0 &&
      tn('{n} move mentioned in the text is not in the engine’s lines; it is marked ⚠.', '{n} moves mentioned in the text are not in the engine’s lines; they are marked ⚠.', report.unchecked),
  ].filter(Boolean)
  return (
    <div className="ask-ai-report">
      <div>✓ {tn('Loaded {n} comment. Step through the game to read it.', 'Loaded {n} comments. Step through the game to read them.', report.comments)}</div>
      {notes.map((n, k) => (
        <div key={k} className="muted">
          {n}
        </div>
      ))}
    </div>
  )
}
