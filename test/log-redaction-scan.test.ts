import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * A full 64-hex room id belongs on a room descriptor a person copies
 * elsewhere, or in a one-off config error somebody is about to go fix -
 * never in the routine status lines a long-running process writes to a log
 * that outlives the terminal somebody was watching (see deploy/README.md's
 * "Logs" section). This is a static, pattern-based check, not a semantic
 * one: it looks at the source text of every non-test file in `server/` and
 * `src/node/` for a room id reaching `log(...)` or `console.*(...)`
 * unsliced, the same shape the forwarder's startup banner had until it was
 * fixed to use `shortId`.
 */

function sourceFiles(dir: string, extension: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(extension) && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.test.mjs'))
    .map((entry) => join(dir, entry.name))
}

/**
 * The argument text of every `log(...)`, `console.log(...)`,
 * `console.error(...)` or `console.warn(...)` call in `source`, matched by
 * counting parentheses rather than a full parser - good enough for this
 * codebase's style, where nobody nests one logging call inside another's
 * arguments.
 */
function loggerCallArguments(source: string): string[] {
  const calls: string[] = []
  const opener = /\b(?:log|console\.(?:log|error|warn))\s*\(/g
  let match: RegExpExecArray | null
  while ((match = opener.exec(source))) {
    let depth = 1
    let i = match.index + match[0].length
    const start = i
    while (i < source.length && depth > 0) {
      if (source[i] === '(') depth++
      else if (source[i] === ')') depth--
      i++
    }
    calls.push(source.slice(start, i - 1))
  }
  return calls
}

/** Every `${...}` interpolation's inner text within `text`. Does not handle
 *  nested braces inside the interpolation - not needed for the pattern this
 *  is looking for. */
function interpolations(text: string): string[] {
  return [...text.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1]!)
}

const files = [...sourceFiles('server', '.mjs'), ...sourceFiles('src/node', '.ts')]

describe('no full room id reaches a logger', () => {
  it.each(files)('%s', (file) => {
    const source = readFileSync(file, 'utf8')
    for (const call of loggerCallArguments(source)) {
      for (const expr of interpolations(call)) {
        if (/\broomId\b/.test(expr) && !/\.slice\s*\(|\bshortId\s*\(/.test(expr)) {
          throw new Error(`${file}: an unsliced room id reaches a logger - \${${expr.trim()}}`)
        }
      }
    }
    expect(true).toBe(true)
  })
})
