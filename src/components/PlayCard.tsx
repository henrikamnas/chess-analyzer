import { useState } from 'react'
import { Chess } from 'chess.js'
import type { BotStrength } from '../bot'
import { t } from '../i18n'

export interface PlaySettings {
  bot: 'w' | 'b' // the computer's side
  strength: BotStrength
  name: string // what the strength is called, e.g. "like joey933 (727)"
}

const LEVELS = [800, 1000, 1200, 1500, 1800, 2100]

interface SetupProps {
  defaultSide: 'w' | 'b' // the side the user plays by default
  /** The game's player on a side and how strong they are (rating, or estimate from the review), if known. */
  player: (side: 'w' | 'b') => { name: string; rating: number | null }
  onStart: (settings: PlaySettings) => void
}

/** "Play on against the computer": pick a side and how strong the computer is, then start from this position. */
export function PlaySetup({ defaultSide, player, onStart }: SetupProps) {
  const [open, setOpen] = useState(false)
  const [side, setSide] = useState(defaultSide)
  const [choice, setChoice] = useState<string>('like')
  const bot = side === 'w' ? 'b' : 'w'
  const opp = player(bot)

  if (!open) return <button onClick={() => setOpen(true)}>🤖 {t('Play on against the computer')}</button>

  const start = () => {
    const like = choice === 'like' && opp.rating !== null
    const strength = like ? opp.rating : choice === 'max' ? null : Number(choice === 'like' ? 1200 : choice)
    const name = like
      ? t('like {name} ({rating})', { name: opp.name, rating: opp.rating! })
      : strength === null
        ? t('full strength')
        : t('rated about {rating}', { rating: strength })
    setOpen(false)
    onStart({ bot, strength, name })
  }

  return (
    <div className="play-setup">
      <div className="play-row">
        <span>{t('You play')}</span>
        <span className="seg" role="group" aria-label={t('You play')}>
          <button className={side === 'w' ? 'on' : ''} onClick={() => setSide('w')}>
            {t('White')}
          </button>
          <button className={side === 'b' ? 'on' : ''} onClick={() => setSide('b')}>
            {t('Black')}
          </button>
        </span>
      </div>
      <label className="play-row">
        <span>{t('Computer plays')}</span>
        <select value={choice} onChange={(e) => setChoice(e.target.value)}>
          {opp.rating !== null && <option value="like">{t('like {name} ({rating})', { name: opp.name, rating: opp.rating })}</option>}
          {LEVELS.map((r) => (
            <option key={r} value={String(r)}>
              {t('rated about {rating}', { rating: r })}
            </option>
          ))}
          <option value="max">{t('full strength')}</option>
        </select>
      </label>
      <div className="muted small">{t('Tip: a little stronger than you is best for practice.')}</div>
      <div className="row">
        <button className="primary" onClick={start}>
          ▶ {t('Start game')}
        </button>
        <button className="link" onClick={() => setOpen(false)}>
          {t('Cancel')}
        </button>
      </div>
    </div>
  )
}

interface CardProps {
  play: PlaySettings
  fen: string // the latest position of the game
  atEnd: boolean // false while looking back at an earlier move
  onResume: () => void
  onStop: () => void
}

/** While playing: whose turn it is, the result when the game ends, and a button to stop and look at the moves. */
export function PlayCard({ play, fen, atEnd, onResume, onStop }: CardProps) {
  const chess = new Chess(fen)
  const human = play.bot === 'w' ? 'b' : 'w'
  const result = chess.isCheckmate()
    ? chess.turn() === human
      ? t('Checkmate. The computer won.')
      : t('Checkmate. You won!')
    : chess.isStalemate()
      ? t('Stalemate: a draw.')
      : chess.isInsufficientMaterial()
        ? t('Draw: not enough material to mate.')
        : chess.isDraw()
          ? t('Draw.')
          : null
  return (
    <div className="card play-card">
      <div>
        <strong>🤖 {t('Playing the computer')}</strong> <span className="muted">· {play.name}</span>
      </div>
      <p className="why">
        {!atEnd && !result
          ? t('Looking back at an earlier move. The game waits until you return.')
          : (result ?? (chess.turn() === play.bot ? t('The computer is thinking…') : t('Your move.')))}
        {!result && atEnd && <span className="muted"> {t('The engine stays quiet while you play.')}</span>}
      </p>
      <div className="row">
        {!atEnd && !result && (
          <button className="primary" onClick={onResume}>
            ⏭ {t('Back to the game')}
          </button>
        )}
        <button className={result ? 'primary' : ''} onClick={onStop}>
          {result ? t('Review the moves') : t('Stop and review')}
        </button>
      </div>
    </div>
  )
}
