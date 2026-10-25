import { useState } from 'react'
import { Chess } from 'chess.js'
import type { BotStrength } from '../bot'
import type { OpeningLine } from '../openingLines'
import { lichessRating } from '../explorer'
import { maiaRating } from '../maia'
import { t } from '../i18n'

export interface PlaySettings {
  bot: 'w' | 'b' // the computer's side
  strength: BotStrength
  name: string // what the strength is called, e.g. "like joey933 (727)"
  human?: boolean // play like a human of that rating (Maia) rather than a weakened engine, where Maia covers it
  // opening practice: book moves first (all: for names; tricky: favour the moves that score best)
  training?: { selection: string; lines: OpeningLine[]; all: OpeningLine[]; tricky: boolean }
}

export const LEVELS = [800, 1000, 1200, 1500, 1800, 2100]

/** Whether Maia has a network for a strength (Chess.com rating): up to about Chess.com 1850. */
export const humanAvailable = (strength: BotStrength) => strength !== null && maiaRating(lichessRating(strength)) !== null

/** Opening practice: where the moves stand against the book. */
export interface TrainingInfo {
  opening: string | null // the deepest named position reached
  state: 'book' | 'ended' | 'left' | 'off' // off: the user chose to play on after leaving the book
  played?: string // the move that left the book (SAN)
  book?: string[] // the book moves there (SAN, with how often they're played)
  /** The last move against what players at the level play: share of games and the mover's score (0–1). */
  last?: { san: string; you: boolean; share: number | null; score: number | null }
  who?: string // the players the shares below are for, e.g. "players rated about 1200"
  /** You're to move in a position where few players at the level find a move that works (the share). */
  ahead?: number
  /** Your latest move was one few players at the level find. */
  found?: { san: string; p: number }
}

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
  const [human, setHuman] = useState(true)
  const bot = side === 'w' ? 'b' : 'w'
  const opp = player(bot)
  const chosen: BotStrength = choice === 'like' && opp.rating !== null ? opp.rating : choice === 'max' ? null : Number(choice === 'like' ? 1200 : choice)

  if (!open) return <button onClick={() => setOpen(true)}>🤖 {t('Play on against the computer')}</button>

  const start = () => {
    const like = choice === 'like' && opp.rating !== null
    const strength = chosen
    const name = like
      ? t('like {name} ({rating})', { name: opp.name, rating: opp.rating! })
      : strength === null
        ? t('full strength')
        : t('rated about {rating}', { rating: strength })
    setOpen(false)
    const asHuman = human && humanAvailable(strength)
    onStart({ bot, strength, name: asHuman ? `${name} · ${t('human-like')}` : name, human: asHuman })
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
      {humanAvailable(chosen) && (
        <div className="play-row">
          <span>{t('Style')}</span>
          <span className="seg" role="group" aria-label={t('Style')}>
            <button className={human ? 'on' : ''} onClick={() => setHuman(true)}>
              {t('Human-like')}
            </button>
            <button className={!human ? 'on' : ''} onClick={() => setHuman(false)}>
              {t('Engine')}
            </button>
          </span>
        </div>
      )}
      <div className="muted small">
        {humanAvailable(chosen) && human
          ? t('Human-like: plays the moves players of that rating play, mistakes included (Maia, trained on Lichess games).')
          : t('Engine: Stockfish, held back to about that rating.')}{' '}
        {t('Tip: a little stronger than you is best for practice.')}
      </div>
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
  training?: TrainingInfo
  onRetry?: () => void // take back the move that left the book
  onPlayOn?: () => void // carry on without the book
  onUndo?: () => void // take back your last move (absent before you've made one)
}

const pct = (x: number) => (x < 0.01 ? '<1' : String(Math.round(100 * x)))

/** While playing: whose turn it is, the result when the game ends, and a button to stop and look at the moves. */
export function PlayCard({ play, fen, atEnd, onResume, onStop, training, onRetry, onPlayOn, onUndo }: CardProps) {
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
        {play.training ? (
          <>
            <strong>📖 {t('Opening practice')}</strong> <span className="muted">· {play.training.selection}</span>
          </>
        ) : (
          <>
            <strong>🤖 {t('Playing the computer')}</strong> <span className="muted">· {play.name}</span>
          </>
        )}
      </div>
      {training && atEnd && !result && (
        <div className={`training-note ${training.state}`}>
          {training.state === 'left' ? (
            <>
              <p>
                {t('{move} is not in the book here. Book moves: {moves}.', { move: training.played!, moves: training.book!.join(', ') })}
              </p>
              <div className="row">
                <button className="primary" onClick={onRetry}>
                  ↺ {t('Try again')}
                </button>
                <button onClick={onPlayOn}>{t('Play on from here')}</button>
              </div>
            </>
          ) : training.state === 'ended' ? (
            <p>{t('End of the book line{name}. The computer plays on from here ({strength}).', { name: training.opening ? `: ${training.opening}` : '', strength: play.name })}</p>
          ) : training.state === 'off' ? (
            <p>{t('Off book. The computer plays on ({strength}).', { strength: play.name })}</p>
          ) : (
            <p>📖 {training.opening ?? t('Starting position')}</p>
          )}
          {training.last && training.state !== 'left' && (
            <p className="muted small">
              {training.last.share === null
                ? t('{move}: rarely played at this level.', { move: training.last.san })
                : t('{move}: played in {share}% of games at this level, scoring {score}% for the side playing it.', {
                    move: training.last.san,
                    share: pct(training.last.share),
                    score: pct(training.last.score ?? 0.5),
                  })}
            </p>
          )}
          {training.found && (
            <p className="small found-it">
              👏 {t('Well found: only {n}% of {who} find {move} or another good move there.', { n: pct(training.found.p), who: training.who!, move: training.found.san })}
            </p>
          )}
          {training.ahead !== undefined && atEnd && chess.turn() !== play.bot && (
            <p className="small tricky-ahead">
              ⚠ {t('A tricky one: only {n}% of {who} find a good move here.', { n: pct(training.ahead), who: training.who! })}
            </p>
          )}
        </div>
      )}
      <p className="why">
        {!atEnd && !result
          ? t('Looking back at an earlier move. The game waits until you return.')
          : (result ?? (training?.state === 'left' ? t('Your move.') : chess.turn() === play.bot ? t('The computer is thinking…') : t('Your move.')))}
        {!result && atEnd && <span className="muted"> {t('The engine stays quiet while you play.')}</span>}
      </p>
      <div className="row">
        {!atEnd && !result && (
          <button className="primary" onClick={onResume}>
            ⏭ {t('Back to the game')}
          </button>
        )}
        {onUndo && (
          <button onClick={onUndo} title={t('Take back your last move')}>
            ↶ {t('Undo')}
          </button>
        )}
        <button className={result ? 'primary' : ''} onClick={onStop}>
          {result ? t('Review the game') : t('Stop and review')}
        </button>
      </div>
    </div>
  )
}
