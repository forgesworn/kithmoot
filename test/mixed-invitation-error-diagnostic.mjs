import { createHash } from 'node:crypto'

const hash = value => createHash('sha256').update(value).digest('hex')
const allowedName = /^(?:Error|TypeError|RangeError|AbortError|TimeoutError|NotAllowedError|InvalidStateError)$/
const allowedFunction = /^(?:async )?(?:new )?[A-Za-z_$][A-Za-z0-9_.$]*$/
const sourceLine = /^\s*at (?:(.*?) \()?((?:https?:\/\/)[^\s)]+):(\d+):(\d+)\)?\s*$/

// Read stack lines transiently. Only code locations inside this local app are
// returned; query strings, error text, URL arguments and foreign frames vanish.
export function appSourceFrames(error, appOrigin, sourceRoot, knownModules, limit = 6) {
  const stack = typeof error?.stack === 'string' ? error.stack : ''
  const frames = []
  for (const line of stack.split('\n').slice(1, 41)) {
    const match = sourceLine.exec(line)
    if (!match) continue
    let url
    try { url = new URL(match[2]) } catch { continue }
    const appPath = url.pathname.startsWith('/j/src/')
    const libraryPath = url.pathname.startsWith(`/j/@fs${sourceRoot}/src/`) || url.pathname.startsWith(`/@fs${sourceRoot}/src/`)
    if (url.origin !== appOrigin || (!appPath && !libraryPath)) continue
    const module = url.pathname.split('/').at(-1)
    if (!/^[A-Za-z0-9_.-]+\.(?:ts|tsx|js|mjs)$/.test(module) || !knownModules.has(module)) continue
    const lineNumber = Number(match[3]), column = Number(match[4])
    if (!Number.isSafeInteger(lineNumber) || lineNumber < 1 || !Number.isSafeInteger(column) || column < 1) continue
    frames.push({ functionName: allowedFunction.test(match[1] ?? '') ? match[1] : 'anonymous', module, line: lineNumber, column })
    if (frames.length >= limit) break
  }
  return frames
}

export function safeErrorDiagnostic(error, appOrigin, sourceRoot, knownModules, source) {
  const name = allowedName.test(error?.name) ? error.name : 'Error'
  const message = String(error?.message ?? error)
  return { source, name, messageSha256: hash(message), sourceStackFrames: appSourceFrames(error, appOrigin, sourceRoot, knownModules) }
}
