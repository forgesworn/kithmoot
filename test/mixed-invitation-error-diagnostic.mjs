import { createHash } from 'node:crypto'

const hash = value => createHash('sha256').update(value).digest('hex')
const allowedName = /^(?:Error|TypeError|RangeError|AbortError|TimeoutError|NotAllowedError|InvalidStateError)$/
const allowedFunction = /^(?:async )?(?:new )?[A-Za-z_$][A-Za-z0-9_.$]*$/
const sourceLine = /^\s*at (?:(.*?) \()?((?:(?:https?|chrome-extension|file):\/\/)[^\s)]+):(\d+):(\d+)\)?\s*$/

// This is an operator-only preview of an error, never a traffic observation.
// Broad masking deliberately sacrifices some explanatory words. It cannot
// prove arbitrary unknown error text is non-secret outside this fixture.
export function redactedMessagePreview(value, privateTerms = []) {
  let text = String(value ?? '')
  for (const term of privateTerms) if (typeof term === 'string' && term) text = text.replaceAll(term, '[private-term]')
  return text
    .replace(/\b[a-z][a-z0-9+.-]{1,30}:(?:\/\/)?[^\s<>"'`]+/gi, '[url]')
    .replace(/(?:\/[A-Za-z0-9_.~-]+){2,}/g, '[path]')
    .replace(/(?<![A-Za-z0-9])[0-9a-fA-F]{16,}(?![A-Za-z0-9])/g, '[hex]')
    .replace(/(?<![A-Za-z0-9_+/-])[A-Za-z0-9_+/-]{22,}={0,2}(?![A-Za-z0-9_+/-])/g, '[token]')
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .slice(0, 300)
}

// Read stack lines transiently. Only code locations inside this local app are
// returned; query strings, error text, URL arguments and foreign frames vanish.
export function appSourceFrames(error, appOrigin, sourceRoot, knownModules, options = {}, limit = 6) {
  const stack = typeof error?.stack === 'string' ? error.stack : ''
  const frames = []
  for (const line of stack.split('\n').slice(1, 41)) {
    const match = sourceLine.exec(line)
    if (!match) continue
    let url
    try { url = new URL(match[2]) } catch { continue }
    const localApp = url.origin === appOrigin, ownFile = url.protocol === 'file:' && url.pathname.startsWith(`${sourceRoot}/`)
    const sourcePath = url.pathname.replace(/^\/j\/@fs/, '').replace(/^\/@fs/, '')
    let sourceClass
    if (localApp && url.pathname.startsWith('/j/src/')) sourceClass = 'app'
    else if ((localApp || ownFile) && sourcePath.startsWith(`${sourceRoot}/src/`)) sourceClass = 'library'
    else if ((localApp || ownFile) && sourcePath.startsWith(`${sourceRoot}/packages/`) && sourcePath.includes('/src/')) sourceClass = 'worktree-package'
    else if (localApp && (url.pathname.startsWith('/j/node_modules/') || sourcePath.startsWith(`${sourceRoot}/node_modules/`))) sourceClass = 'dependency'
    else if (ownFile && url.pathname.startsWith(`${sourceRoot}/node_modules/`)) sourceClass = 'dependency'
    else if (url.protocol === 'chrome-extension:' && url.host === new URL(options.barkOrigin ?? 'chrome-extension://invalid').host) sourceClass = 'bark-extension'
    if (!sourceClass) continue
    const module = url.pathname.split('/').at(-1)
    const catalog = sourceClass === 'worktree-package' ? options.packageModules : sourceClass === 'dependency' ? options.dependencyModules : sourceClass === 'bark-extension' ? options.barkModules : knownModules
    const knownModule = /^[A-Za-z0-9_.-]+\.(?:ts|tsx|js|mjs)$/.test(module) && catalog?.has(module)
    if (!knownModule && sourceClass !== 'dependency') continue
    const lineNumber = Number(match[3]), column = Number(match[4])
    if (!Number.isSafeInteger(lineNumber) || lineNumber < 1 || !Number.isSafeInteger(column) || column < 1) continue
    const rawFunction = match[1] ?? ''
    const functionName = allowedFunction.test(rawFunction) && rawFunction.length <= 64 ? redactedMessagePreview(rawFunction, options.privateTerms) : 'anonymous'
    frames.push({ sourceClass, functionName, module:knownModule ? module : 'other', line: lineNumber, column })
    if (frames.length >= limit) break
  }
  return frames
}

export function safeErrorDiagnostic(error, appOrigin, sourceRoot, knownModules, source, options = {}) {
  const name = allowedName.test(error?.name) ? error.name : 'Error'
  const message = String(error?.message ?? error)
  return { source, name, messageSha256: hash(message), operatorMessagePreview:redactedMessagePreview(message,options.privateTerms),
    sourceStackFrames: appSourceFrames(error, appOrigin, sourceRoot, knownModules, options) }
}
