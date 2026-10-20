import { useState } from 'react'
import { buildPositionPrompt, type PositionContext } from '../aiPrompt'
import { t } from '../i18n'

// Chats that accept a prefilled message in the link. Not officially documented, so the prompt is always copied
// too: if a chat opens empty, the user pastes it.
const CHATS = [
  { name: 'Claude', url: (q: string) => `https://claude.ai/new?q=${encodeURIComponent(q)}` },
  { name: 'ChatGPT', url: (q: string) => `https://chatgpt.com/?q=${encodeURIComponent(q)}` },
  { name: 'Gemini', url: () => 'https://gemini.google.com/app' }, // no prefill: paste
]

/** "Chat about this position": copies the position with the engine's facts as a prompt and opens an AI chat. */
export function PositionChat({ context }: { context: () => PositionContext }) {
  const [prompt, setPrompt] = useState<string | null>(null)
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle')

  const start = async () => {
    const text = buildPositionPrompt(context())
    setPrompt(text)
    try {
      await navigator.clipboard.writeText(text)
      setStatus('copied')
    } catch {
      setStatus('failed') // no clipboard access (e.g. plain http on another device): show the text instead
    }
  }

  return (
    <div className="position-chat">
      {status === 'idle' ? (
        <button onClick={start}>💬 {t('Chat about this position')}</button>
      ) : (
        <>
          <div className="ask-ai-row">
            <span>{status === 'copied' ? `✓ ${t('Copied. Open a chat:')}` : t('Open a chat:')}</span>
            {CHATS.map((c) => (
              <a key={c.name} href={c.url(prompt!)} target="_blank" rel="noreferrer" onClick={() => setStatus('idle')}>
                {c.name}
              </a>
            ))}
            <button className="link" onClick={() => setStatus('idle')}>
              {t('Cancel')}
            </button>
          </div>
          <div className="muted small">{t('If the chat opens empty, paste the prompt (it is on your clipboard).')}</div>
          {status === 'failed' && (
            <>
              <div className="muted small">{t('Could not copy automatically. Select the text below and copy it:')}</div>
              <textarea className="ask-ai-text" readOnly value={prompt!} onFocus={(e) => e.currentTarget.select()} />
            </>
          )}
        </>
      )}
    </div>
  )
}
