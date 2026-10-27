// AI commentary for any game: the user copies a prompt (aiPrompt.ts, mode 'commentary') into their own AI chat
// and pastes the JSON answer back. Before the app shows it, the answer is checked against the game and the
// engine review, much like the famous games' commentary was (scripts/check-commentary.mjs): comments must point
// at moves of the game and lines must be legal; lines that leave the engine's (or the game's) moves are kept but
// labelled as the AI's own, and numbered moves in the text that nothing backs up are flagged. Kept in this browser only.
import { useSyncExternalStore } from 'react'
import { Chess } from 'chess.js'
import type { Game, Review } from './analysis'
import type { Commentary, MoveComment } from './commentary'

export interface ImportReport {
  comments: number
  skipped: string[] // comments whose move isn't in the game
  linesOwn: number // legal lines that leave the engine's and the game's moves: kept, labelled as the AI's own
  linesShortened: number // lines cut at an illegal move
  linesDropped: number // lines whose first move is illegal
  unchecked: number // numbered moves in the texts that couldn't be checked
}

export type ParseResult = { commentary: Commentary; report: ImportReport } | { error: string }

// "16.Qb8+", "13...Nxd7", "13. Nxd7" (the same pattern as scripts/check-commentary.mjs, plus castling with zeros)
const MOVE = /\b(\d+)\.(\.\.)?\s?((?:[KQRBN][a-h]?[1-8]?x?[a-h][1-8]|[a-h]x[a-h][1-8](?:=[QRBN])?|[a-h][1-8](?:=[QRBN])?|O-O-O|O-O|0-0-0|0-0)[+#]?)/g
const norm = (san: string) => san.replace(/[+#!?]/g, '').replace(/0/g, 'O')
const keyOf = (fenBefore: string, san: string) => `${fenBefore.split(' ')[5]}${fenBefore.split(' ')[1]} ${norm(san)}`

/** Plays UCI moves from a position, as [fen before, SAN] pairs, stopping at the first illegal one. */
function playUci(fen: string, pv: string[]) {
  const chess = new Chess(fen)
  const out: { fen: string; san: string; uci: string }[] = []
  for (const uci of pv) {
    const before = chess.fen()
    try {
      const m = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] })
      out.push({ fen: before, san: m.san, uci })
    } catch {
      break
    }
  }
  return out
}

/** The text of the answer as JSON: the ```json block if there is one, else everything from the first { to the last }. */
function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const body = fenced && fenced[1].includes('{') ? fenced[1] : text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)
  if (!body.trim()) return null
  for (const candidate of [body, body.replace(/,\s*([}\]])/g, '$1').replace(/[“”]/g, '"')]) {
    try {
      return JSON.parse(candidate)
    } catch {
      // try the next clean-up
    }
  }
  return null
}

export function parseAiCommentary(text: string, game: Game, review: Review): ParseResult {
  const data = extractJson(text) as { intro?: unknown; summary?: unknown; comments?: unknown } | null
  if (!data || typeof data !== 'object') return { error: 'no-json' }
  if (!Array.isArray(data.comments) || !data.comments.length) return { error: 'no-comments' }

  const n = game.plies.length
  const fenAt = (i: number) => (i < n ? game.plies[i].fenBefore : game.plies[n - 1].fenAfter) // position after i moves
  // Everything a numbered move in the text may refer to: the game's moves and the engine's lines
  const known = new Set(game.plies.map((p) => keyOf(p.fenBefore, p.san)))
  for (let i = 0; i <= n; i++) for (const m of playUci(fenAt(i), review.evals[i]?.pv ?? [])) known.add(keyOf(m.fen, m.san))

  const report: ImportReport = { comments: 0, skipped: [], linesOwn: 0, linesShortened: 0, linesDropped: 0, unchecked: 0 }
  const check = (txt: string, own: Set<string>) => {
    const bad = [...txt.matchAll(MOVE)].filter((m) => !own.has(`${m[1]}${m[2] ? 'b' : 'w'} ${norm(m[3])}`)).map((m) => m[0])
    report.unchecked += bad.length
    return bad.length ? { unchecked: [...new Set(bad)] } : {}
  }
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

  const comments: MoveComment[] = []
  for (const raw of data.comments as { move?: unknown; text?: unknown; line?: { from?: unknown; moves?: unknown } }[]) {
    const move = str(raw?.move)
    const body = str(raw?.text)
    if (!body) continue
    const found = findPly(game, move)
    if (!found) {
      report.skipped.push(move || '?')
      continue
    }
    const i = found.ply
    const own = new Set(known)
    let line: MoveComment['line']
    // A comment on a position ("17...") is shown after the move that led to it, and its line starts there
    const from = raw.line?.from === 'before' || raw.line?.from === 'after' ? (found.position ? 'after' : raw.line.from) : null
    if (from && Array.isArray(raw.line!.moves) && raw.line!.moves.length) {
      const start = from === 'before' ? i : i + 1
      // Lines that follow the engine's line from there, or the game itself, are checked; others are the AI's own
      const refs = [review.evals[start]?.pv ?? [], game.plies.slice(start).map((p) => p.uci)]
      const sans = (raw.line!.moves as unknown[]).map(str)
      const { played: kept, grounded } = legalLine(fenAt(start), sans, refs)
      if (!kept.length) report.linesDropped++
      else {
        if (kept.length < sans.length) report.linesShortened++
        const ownLine = grounded < kept.length
        if (ownLine) report.linesOwn++
        line = { from, san: kept.map((m) => m.san), ...(ownLine ? { own: true } : {}) }
        for (const m of kept) own.add(keyOf(m.fen, m.san))
      }
    }
    comments.push({ ply: i, en: body, sv: body, ...(line ? { line } : {}), ...check(body, own) })
  }
  // Mostly moves this game doesn't have: the answer is for another game
  if (report.skipped.length > comments.length) return { error: 'other-game' }
  if (!comments.length) return { error: 'no-comments' }
  comments.sort((a, b) => a.ply - b.ply) // stable: comments on the same move keep the AI's order
  report.comments = comments.length

  const text2 = (v: unknown) => {
    const s = str(v)
    return { en: s, sv: s, ...check(s, known) }
  }
  return { commentary: { id: 'ai', intro: text2(data.intro), summary: text2(data.summary), comments }, report }
}

/**
 * The 0-based ply of a move written "14.Nf3", "14...Nxe4" or "14. Nf3"; null if the game has no such move. A bare
 * "17..." (or "17.") is the position with that side to move, e.g. after the last move when the game ended there:
 * the ply of the move that led to it, with `position` set.
 */
function findPly(game: Game, move: string): { ply: number; position?: true } | null {
  const bare = move.replace(/…/g, '...').match(/^(\d+)\s*\.(\.\.)?\s*$/)
  if (bare) {
    const turn = bare[2] ? 'b' : 'w'
    const k = game.plies.findIndex((p) => p.fenAfter.split(' ')[1] === turn && p.fenAfter.split(' ')[5] === bare[1])
    return k >= 0 ? { ply: k, position: true } : null
  }
  const m = move.replace(/…/g, '...').match(/^(\d+)\s*\.(\.\.)?\s*(\S+)/)
  if (!m) return null
  const no = m[1]
  const san = norm(m[3])
  const at = (color: 'w' | 'b') => game.plies.findIndex((p) => p.color === color && p.fenBefore.split(' ')[5] === no && norm(p.san) === san)
  const i = at(m[2] ? 'b' : 'w')
  if (i >= 0) return { ply: i }
  const other = at(m[2] ? 'w' : 'b') // "14.Nxe4" written for Black's move
  return other >= 0 ? { ply: other } : null
}

/** A SAN line's legal start, and how many of its moves agree move for move with one of the reference lines (UCI). */
function legalLine(fen: string, sans: string[], refs: string[][]) {
  const chess = new Chess(fen)
  const played: { fen: string; san: string; uci: string }[] = []
  for (const san of sans) {
    const before = chess.fen()
    try {
      const m = chess.move(san.replace(/^\d+\.+\s*/, '').replace(/0/g, 'O'))
      played.push({ fen: before, san: m.san, uci: m.from + m.to + (m.promotion ?? '') })
    } catch {
      break
    }
  }
  let best = 0
  for (const ref of refs) {
    let k = 0
    while (k < played.length && k < ref.length && played[k].uci === ref[k]) k++
    best = Math.max(best, k)
  }
  return { played, grounded: best }
}

// --- Storage: one commentary per game, in localStorage -------------------------

const PREFIX = 'aiCommentary:'
const listeners = new Set<() => void>()
const cache = new Map<string, Commentary | null>()

/** A key for the game's moves (FNV-1a), so the commentary comes back however the game is loaded again. */
export function aiCommentaryKey(game: Game): string {
  let h = 0x811c9dc5
  for (const ch of game.startFen + ' ' + game.plies.map((p) => p.uci).join(' ')) {
    h ^= ch.charCodeAt(0)
    h = Math.imul(h, 0x01000193)
  }
  return PREFIX + (h >>> 0).toString(36) + '-' + game.plies.length
}

function read(key: string): Commentary | null {
  if (!cache.has(key)) {
    let c: Commentary | null = null
    try {
      const s = localStorage.getItem(key)
      c = s ? (JSON.parse(s) as Commentary) : null
    } catch {
      c = null
    }
    cache.set(key, c)
  }
  return cache.get(key)!
}

export function saveAiCommentary(game: Game, c: Commentary | null) {
  const key = aiCommentaryKey(game)
  cache.set(key, c)
  try {
    if (c) localStorage.setItem(key, JSON.stringify(c))
    else localStorage.removeItem(key)
  } catch {
    // storage full or blocked: it still shows until the page is reloaded
  }
  listeners.forEach((l) => l())
}

/** The game's AI commentary, if the user has pasted one in; updates when it changes. */
export function useAiCommentary(game: Game | null): Commentary | null {
  const key = game && game.plies.length ? aiCommentaryKey(game) : null
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => (key ? read(key) : null),
  )
}
