import { describe, it, expect } from 'vitest'
import { splitLinks } from './linkify.js'

describe('splitting message text into plain runs and links', () => {
  it('finds nothing to split in plain text', () => {
    expect(splitLinks('just a message, no links here')).toEqual([{ kind: 'text', value: 'just a message, no links here' }])
  })

  it('turns an http(s) URL into a link token, keeping the surrounding text', () => {
    expect(splitLinks('see https://example.com/docs for more')).toEqual([
      { kind: 'text', value: 'see ' },
      { kind: 'link', url: 'https://example.com/docs' },
      { kind: 'text', value: ' for more' },
    ])
    expect(splitLinks('http://example.com works too')).toEqual([
      { kind: 'link', url: 'http://example.com' },
      { kind: 'text', value: ' works too' },
    ])
  })

  it('trims a trailing full stop off the URL and keeps it as text', () => {
    expect(splitLinks('read https://example.com/docs.')).toEqual([
      { kind: 'text', value: 'read ' },
      { kind: 'link', url: 'https://example.com/docs' },
      { kind: 'text', value: '.' },
    ])
  })

  it('trims other trailing sentence punctuation the same way', () => {
    for (const [input, url, rest] of [
      ['is it https://example.com?', 'https://example.com', '?'],
      ['go to https://example.com!', 'https://example.com', '!'],
      ['see https://example.com, then this', 'https://example.com', ', then this'],
      ['see https://example.com; then this', 'https://example.com', '; then this'],
      ['"https://example.com"', 'https://example.com', '"'],
    ] as const) {
      const tokens = splitLinks(input)
      const link = tokens.find((t) => t.kind === 'link')
      expect(link, input).toBeDefined()
      expect((link as { url: string }).url).toBe(url)
      expect(tokens.at(-1)).toEqual({ kind: 'text', value: rest })
    }
  })

  it('keeps a closing bracket that is part of the URL, from a balanced opening one', () => {
    expect(splitLinks('see https://example.com/wiki/Foo_(bar) for detail')).toEqual([
      { kind: 'text', value: 'see ' },
      { kind: 'link', url: 'https://example.com/wiki/Foo_(bar)' },
      { kind: 'text', value: ' for detail' },
    ])
  })

  it('strips an unbalanced closing bracket that belongs to the sentence around a bare link', () => {
    expect(splitLinks('(see https://example.com)')).toEqual([
      { kind: 'text', value: '(see ' },
      { kind: 'link', url: 'https://example.com' },
      { kind: 'text', value: ')' },
    ])
  })

  it('never matches a javascript: or other non-http(s) scheme', () => {
    for (const text of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'not a link: mailto:a@b.com']) {
      expect(splitLinks(text)).toEqual([{ kind: 'text', value: text }])
    }
  })

  it('finds more than one link in the same message', () => {
    expect(splitLinks('https://a.example and https://b.example too')).toEqual([
      { kind: 'link', url: 'https://a.example' },
      { kind: 'text', value: ' and ' },
      { kind: 'link', url: 'https://b.example' },
      { kind: 'text', value: ' too' },
    ])
  })

  it('does not truncate a very long URL - wrapping it is a display concern, not a splitting one', () => {
    const long = 'https://example.com/' + 'a'.repeat(500)
    expect(splitLinks(`see ${long}`)).toEqual([
      { kind: 'text', value: 'see ' },
      { kind: 'link', url: long },
    ])
  })
})
