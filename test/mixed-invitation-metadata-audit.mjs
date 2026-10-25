import { createHash } from 'node:crypto'
import { wireMatches } from './mixed-invitation-wire-audit.mjs'

export const sha256 = value => createHash('sha256').update(value).digest('hex')
const knownFrameTypes = new Set(['EVENT', 'REQ', 'COUNT', 'CLOSE', 'AUTH', 'EOSE', 'OK', 'NOTICE'])
const knownTags = new Set(['e', 'p', 'a', 'd', 't', 'r', 'relay', 'challenge', 'expiration', 'scope', 'device', 'server', 'status', 'grant'])
const knownQueryKeys = new Set(['since', 'until', 'limit', 'kind', 'kinds', 'author', 'authors', 'search'])
const knownHeaders = new Set(['accept', 'authorization', 'content-type', 'content-length', 'origin', 'user-agent', 'x-api-key'])
export const safeNumber = value => Number.isInteger(value) && value >= 0 && value <= 65535 ? value : undefined
export const keyClass = value => typeof value === 'string' && (knownTags.has(value) || /^#[A-Za-z0-9]$/.test(value) || knownQueryKeys.has(value)) ? value : 'other'
const digestValues = values => values.map(value => sha256(JSON.stringify(value)))

export function endpointSummary(url, knownOrigins = {}) {
  try {
    const value = new URL(url)
    return { originAlias: knownOrigins[value.origin] ?? 'other', originSha256: sha256(value.origin),
      pathSha256: sha256(value.pathname), pathSegments: value.pathname.split('/').filter(Boolean).length,
      query: [...value.searchParams].map(([key, val]) => ({ keyClass: keyClass(key), valueSha256: sha256(val) })) }
  } catch { return { endpointUnknown: true } }
}

function filterShape(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { malformed: true }
  const keys = Object.keys(value).sort()
  return { keys: keys.map(keyClass), kinds: Array.isArray(value.kinds) ? value.kinds.map(safeNumber).filter(v => v !== undefined) : [],
    selectors: keys.filter(key => key !== 'kinds').map(key => ({ keyClass: keyClass(key), count: Array.isArray(value[key]) ? value[key].length : 1,
      valueSha256: digestValues(Array.isArray(value[key]) ? value[key] : [value[key]]) })) }
}
function eventShape(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { malformed: true }
  return { kind: safeNumber(value.kind), authorSha256: typeof value.pubkey === 'string' ? sha256(value.pubkey) : undefined,
    contentLength: typeof value.content === 'string' ? Buffer.byteLength(value.content) : undefined,
    tags: Array.isArray(value.tags) ? value.tags.map(tag => Array.isArray(tag) ? { keyClass:keyClass(tag[0]), valueCount:Math.max(0,tag.length-1),
      valueSha256:digestValues(tag.slice(1)) } : { malformed:true }) : [] }
}

export function frameSummary(payload, controlSubscription) {
  const wire = Buffer.from(payload)
  const basic = { length: wire.length, sha256: sha256(wire), type: 'opaque' }
  try {
    const value = JSON.parse(wire.toString('utf8'))
    if (!Array.isArray(value) || !knownFrameTypes.has(value[0])) return basic
    const type = value[0]
    const subscription = ['REQ', 'COUNT', 'CLOSE'].includes(type) && typeof value[1] === 'string' ? value[1] : undefined
    const control = !!controlSubscription && subscription === controlSubscription ? type : undefined
    return { ...basic, type, ...(subscription ? { subscriptionSha256:sha256(subscription) } : {}),
      ...(control ? { control } : {}),
      ...(['REQ', 'COUNT'].includes(type) ? { filters:value.slice(2).map(filterShape), filterCount:Math.max(0,value.length-2) } : {}),
      ...(['EVENT', 'AUTH'].includes(type) ? { event:eventShape(value[1]) } : {}) }
  } catch { return basic }
}

export function httpSummary(url, method, headers, body, hasPostData, source, knownOrigins = {}) {
  const bytes = body == null ? null : Buffer.from(body)
  const headerEntries = headers && typeof headers === 'object' ? Object.entries(headers) : null
  const unavailableFields = [...(headerEntries ? source === 'app-http' ? ['browser-excluded-headers'] : [] : ['headers']),
    ...(hasPostData && !bytes ? ['request-body'] : [])]
  return { source, ...endpointSummary(url, knownOrigins), method:typeof method === 'string' ? method.toUpperCase() : 'UNKNOWN',
    headerCoverage:headerEntries ? source === 'app-http' ? 'reported-only' : 'reported-by-CDP' : 'unavailable', unavailableFields,
    headers:headerEntries?.map(([key,value]) => ({ nameClass:knownHeaders.has(key.toLowerCase())?key.toLowerCase():'other', valueSha256:sha256(String(value)) })) ?? [],
    bodyAudit:hasPostData ? bytes ? 'observed' : 'unavailable' : 'none', length:bytes?.length ?? 0,
    ...(bytes ? { sha256:sha256(bytes) } : {}) }
}

export function matchesNeedleNow(needles, values) {
  let matches=0
  for(const value of values) if(value!=null) {
    const bytes=Buffer.from(value)
    for(const needle of needles) if(wireMatches(bytes,needle))matches++
  }
  return matches
}

export function withinBudget(currentBytes, nextBytes, limit = 16 * 1024 * 1024) {
  return currentBytes + nextBytes <= limit ? { bytes:currentBytes+nextBytes, overflow:false } : { bytes:currentBytes, overflow:true }
}

export function assertProspectiveNeedles(requested, armed) {
  if(requested === undefined)return
  if(!Array.isArray(requested)||JSON.stringify(requested)!==JSON.stringify(armed))throw new Error('Retrospective needles are unavailable; arm before the window')
}

export function windowTransition(summary, name, nextNeedles, namedWindows) {
  if(!namedWindows.has(name)||!Array.isArray(nextNeedles)||nextNeedles.some(n=>typeof n!=='string'||!n||n.length>2*1024*1024))
    throw new Error('Named window and bounded prospective needles required')
  return { closed:JSON.parse(JSON.stringify(summary)), name, needles:[...nextNeedles] }
}
