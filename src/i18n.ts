// Minimal i18n: English text is the key, Swedish translations live in sv.ts. A missing translation
// falls back to the English text, so nothing ever renders as a blank or a key name.
import { useSyncExternalStore } from 'react'
import { SV } from './sv'

export type Lang = 'en' | 'sv'

const KEY = 'chess-analyzer:lang'
const listeners = new Set<() => void>()

function initialLang(): Lang {
  try {
    const saved = localStorage.getItem(KEY)
    if (saved === 'en' || saved === 'sv') return saved
  } catch {
    /* storage unavailable */
  }
  return typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('sv') ? 'sv' : 'en'
}

let current: Lang = initialLang()
if (typeof document !== 'undefined') document.documentElement.lang = current

export function getLang(): Lang {
  return current
}

export function setLang(lang: Lang) {
  current = lang
  try {
    localStorage.setItem(KEY, lang)
  } catch {
    /* storage unavailable */
  }
  document.documentElement.lang = lang
  listeners.forEach((l) => l())
}

/** Current language, re-rendering the component when it changes. */
export function useLang(): Lang {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    getLang,
    getLang,
  )
}

type Params = Record<string, string | number>

/** Translate `text` (the English original) and fill in {placeholders}. */
export function t(text: string, params?: Params): string {
  const template = current === 'sv' ? (SV[text] ?? text) : text
  return params ? template.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m)) : template
}

/** Singular/plural: tn('{n} time', '{n} times', n). Both forms are translated. */
export function tn(one: string, other: string, n: number, params?: Params): string {
  return t(n === 1 ? one : other, { n, ...params })
}

/**
 * A side named inside a sentence: English capitalizes it ("better for White"), Swedish doesn't ("bättre för vit").
 * Headings and labels use t('White') / t('Black') instead.
 */
export function sideInText(color: 'w' | 'b'): string {
  if (current === 'sv') return color === 'w' ? 'vit' : 'svart'
  return color === 'w' ? 'White' : 'Black'
}

/** Locale for dates and numbers. */
export function locale() {
  return current === 'sv' ? 'sv-SE' : 'en-GB'
}
