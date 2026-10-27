// Written commentary for famous games (public/famous/commentary/<id>.json): an introduction, comments on the
// key moves, and a summary, in English and Swedish. Grounded in deep engine analysis of each game and checked
// against it (scripts/commentary-facts.mjs, scripts/check-commentary.mjs).

export interface Text {
  en: string
  sv: string
  /** AI commentary only: numbered moves it mentions that are neither game moves nor in the engine's lines. */
  unchecked?: string[]
}

export interface MoveComment extends Text {
  ply: number // 0-based index of the move commented on
  /** A line to show: from the position before the move (an alternative) or after it (what follows), in SAN. */
  line?: { from: 'before' | 'after'; san: string[]; own?: boolean } // own: AI commentary's own line, not the engine's
}

export interface Commentary {
  id: string
  intro: Text
  summary: Text
  comments: MoveComment[]
}

const cache = new Map<string, Promise<Commentary | null>>()

export function loadCommentary(id: string): Promise<Commentary | null> {
  let p = cache.get(id)
  if (!p) {
    p = fetch(`${import.meta.env.BASE_URL}famous/commentary/${id}.json`)
      .then((r) => (r.ok ? (r.json() as Promise<Commentary>) : null))
      .catch(() => null)
    cache.set(id, p)
  }
  return p
}
