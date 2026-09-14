/**
 * Splitting message text into plain runs and http(s) links.
 *
 * On a phone a bubble's text could not be tapped or copied: a URL somebody
 * pasted just sat there as words, and holding the bubble to select it
 * opened the reaction picker instead (see `.reactableBubble` and
 * `reaction-hold.ts`). This turns an http(s) URL into a real link so it can
 * be tapped, and never anything else - a `javascript:` or `data:` string
 * only ever matches the http(s) pattern by not matching it at all, so it
 * stays plain text and is never made clickable.
 */

export interface TextToken { readonly kind: 'text'; readonly value: string }
export interface LinkToken { readonly kind: 'link'; readonly url: string }
export type MessageToken = TextToken | LinkToken

// Deliberately narrow: http and https only. Nothing else this matches is
// ever turned into an anchor's href, so nothing else this matches can ever
// become a working link, whatever scheme somebody pastes.
const URL_PATTERN = /https?:\/\/[^\s<>]+/gi

const TRAILING = new Set(['.', ',', '!', '?', ';', ':', "'", '"', ')', ']', '}'])
const OPEN_FOR_CLOSE: Record<string, string> = { ')': '(', ']': '[', '}': '{' }

/** Whether `s` holds at least as many `open` as `close` - a Wikipedia-style
 *  URL with a bracket in its path, `.../Foo_(bar)`, keeps its closing
 *  bracket; a sentence's own closing bracket around a bare link does not. */
function bracketsBalance(s: string, open: string, close: string): boolean {
  let depth = 0
  for (const ch of s) { if (ch === open) depth++; else if (ch === close) depth-- }
  return depth >= 0
}

/**
 * Split `text` into plain-text runs and http(s) URLs.
 *
 * Trailing punctuation that almost certainly belongs to the sentence, not
 * the link - the full stop after "see https://example.com." - is trimmed
 * off the URL and left as plain text; a closing bracket that is part of the
 * URL itself, because the URL contains a matching opening one, stays.
 */
export function splitLinks(text: string): MessageToken[] {
  const tokens: MessageToken[] = []
  let at = 0
  for (const match of text.matchAll(URL_PATTERN)) {
    const start = match.index ?? 0
    let end = start + match[0].length
    while (end > start) {
      const last = text[end - 1]!
      if (!TRAILING.has(last)) break
      const open = OPEN_FOR_CLOSE[last]
      if (open && bracketsBalance(text.slice(start, end), open, last)) break
      end--
    }
    if (end <= start) continue
    if (start > at) tokens.push({ kind: 'text', value: text.slice(at, start) })
    tokens.push({ kind: 'link', url: text.slice(start, end) })
    at = end
  }
  if (at < text.length) tokens.push({ kind: 'text', value: text.slice(at) })
  return tokens
}
