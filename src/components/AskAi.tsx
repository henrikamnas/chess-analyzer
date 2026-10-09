import { useState } from 'react'
import type { Game, Review } from '../analysis'
import { buildAiPrompt, type Side } from '../aiPrompt'
import { t } from '../i18n'
import type { BookInfo } from '../openings'

interface Props {
  game: Game
  review: Review
  book: BookInfo | null
  pgn: string
  defaultSide: Side
}

// Opened in a new tab after copying; the user pastes the prompt there (the prompt is too long for URL prefill).
const CHATS = [
  { name: 'Claude', url: 'https://claude.ai/new' },
  { name: 'ChatGPT', url: 'https://chatgpt.com/' },
  { name: 'Gemini', url: 'https://gemini.google.com/app' },
]

/** Copies the game and its engine review as a prompt for any chat LLM, using the user's own subscription. */
export function AskAi({ game, review, book, pgn, defaultSide }: Props) {
  const [side, setSide] = useState<Side>(defaultSide)
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle')
  const [fallback, setFallback] = useState<string | null>(null)

  const copy = async () => {
    const prompt = buildAiPrompt(game, review, book, side, pgn)
    try {
      await navigator.clipboard.writeText(prompt)
      setStatus('copied')
      setFallback(null)
    } catch {
      // No clipboard access (e.g. plain http on another device): show the text to copy by hand
      setStatus('failed')
      setFallback(prompt)
    }
  }

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
        <button className="primary" onClick={copy}>
          📋 {t('Copy for AI')}
        </button>
      </div>
      {status === 'copied' && (
        <div className="ask-ai-row">
          <span>✓ {t('Copied. Paste it into:')}</span>
          {CHATS.map((c) => (
            <a key={c.name} href={c.url} target="_blank" rel="noreferrer">
              {c.name}
            </a>
          ))}
        </div>
      )}
      {status === 'failed' && fallback && (
        <>
          <div className="muted">{t('Could not copy automatically. Select the text below and copy it:')}</div>
          <textarea className="ask-ai-text" readOnly value={fallback} onFocus={(e) => e.currentTarget.select()} />
        </>
      )}
    </div>
  )
}
