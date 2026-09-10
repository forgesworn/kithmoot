import type { ContextView } from './index.js'

export interface ContextRetrievalOptions {
  query: string
  /** UTF-8 bytes of the entire JSON result, including provenance. Not a token estimate. */
  maxBytes?: number
  maxRecords?: number
  includeRelated?: boolean
  /** Explicit observation cutoff; an old decision is not automatically obsolete. */
  observedSince?: number
}
type RecordView = ContextView['records'][number]
export interface ContextLink { from: string; to: string; kind: 'same-source' | 'record-reference' }
export interface ContextRetrieval {
  collection: string; head: string; revision: number; updatedAt: number
  scope: ContextView['scope']; room?: string; query: string
  evidenceOnly: true; cachedRevision: true
  records: (RecordView & { match: 'query' | 'related'; via?: string })[]
  links: ContextLink[]
  availableRecords: number; omitted: number; maxBytes: number; bytesUsed: number
}

const encoder = new TextEncoder()
const stop = new Set('a an and are as at be by for from how i in is it of on or that the this to was we what which with'.split(' '))
function words(text: string): Set<string> {
  return new Set((text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(w => !stop.has(w)))
}
function size(result: ContextRetrieval): number {
  // bytesUsed is itself in the JSON. Settle its digit count before checking the cap.
  let bytes = encoder.encode(JSON.stringify(result)).length
  while (result.bytesUsed !== bytes) {
    result.bytesUsed = bytes
    bytes = encoder.encode(JSON.stringify(result)).length
  }
  return bytes
}

/** A disposable derived view of an already authorised snapshot. Never persists
 * plaintext or follows a source URL. Connections describe provenance, not truth. */
export function retrieveView(view: ContextView, options: ContextRetrievalOptions): ContextRetrieval {
  const { query, maxBytes = 8192, maxRecords = 8, includeRelated = true, observedSince } = options
  if (typeof query !== 'string' || !query.trim() || query.length > 500) throw new Error('Provide a context query of 1 to 500 characters.')
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 32768) throw new Error('Context retrieval budget must be 1024 to 32768 bytes.')
  if (!Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > 20) throw new Error('Context retrieval allows 1 to 20 records.')
  if (typeof includeRelated !== 'boolean' || observedSince !== undefined && (!Number.isSafeInteger(observedSince) || observedSince < 0)) throw new Error('Invalid context retrieval options.')
  const rows = view.records.filter(r => observedSince === undefined || r.observedAt >= observedSince)
  const terms = words(query)
  const indexed = rows.map(row => ({ row, tokens: words(`${row.text}\n${row.source}`) }))
  const weights = new Map([...terms].map(term => [term, 1 + Math.log((rows.length + 1) / (1 + indexed.filter(r => r.tokens.has(term)).length))]))
  const direct = indexed.map(({ row, tokens }) => ({ row, score: [...terms].reduce((s, term) => s + (tokens.has(term) ? weights.get(term)! : 0), 0) }))
    .filter(r => r.score > 0).sort((a, b) => b.score - a.score || b.row.observedAt - a.row.observedAt || a.row.id.localeCompare(b.row.id))
  const links: ContextLink[] = []
  if (includeRelated) {
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      const references = new Set([...`${row.text}\n${row.source}`.matchAll(/\bcontext:([0-9a-f]{64})\b/g)].map(m => m[1]))
      for (let j = 0; j < rows.length; j++) {
        if (i === j) continue
        const other = rows[j]
        if (references.has(other.id)) links.push({ from: row.id, to: other.id, kind: 'record-reference' })
        // Exact source equality is deliberately conservative: do not equate an
        // entire domain, strip a revision/query, or infer an access grant.
        if (i < j && row.source.trim() === other.source.trim()) links.push({ from: row.id, to: other.id, kind: 'same-source' })
      }
    }
  }
  const result: ContextRetrieval = {
    collection: view.id, head: view.head, revision: view.revision, updatedAt: view.updatedAt,
    scope: view.scope, ...(view.room ? { room: view.room } : {}), query,
    evidenceOnly: true, cachedRevision: true, records: [], links: [],
    availableRecords: rows.length, omitted: direct.length, maxBytes, bytesUsed: 0,
  }
  if (size(result) > maxBytes) throw new Error('Context retrieval budget is too small for the query and provenance.')
  const chosen = new Set<string>()
  function add(row: RecordView, match: 'query' | 'related', via?: string): boolean {
    if (chosen.has(row.id) || chosen.size >= maxRecords) return false
    const before = result.links
    const record = { ...row, match, ...(via ? { via } : {}) }
    result.records.push(record)
    chosen.add(row.id)
    result.links = links.filter(l => chosen.has(l.from) && chosen.has(l.to))
    if (size(result) > maxBytes) {
      result.records.pop(); chosen.delete(row.id); result.links = before; size(result)
      return false
    }
    return true
  }
  for (const { row } of direct) add(row, 'query')
  // Only neighbours of a returned query hit may expand the result. No recursive
  // traversal, no external collection reads, and no orphaned explanation IDs.
  const seeds = new Set(chosen)
  const related = rows.filter(r => !direct.some(d => d.row.id === r.id)).map(row => {
    const link = links.find(l => l.from === row.id && seeds.has(l.to) || l.to === row.id && seeds.has(l.from))
    return { row, via: link && (link.from === row.id ? link.to : link.from) }
  }).filter(r => r.via).sort((a, b) => b.row.observedAt - a.row.observedAt || a.row.id.localeCompare(b.row.id))
  for (const { row, via } of related) add(row, 'related', via)
  result.omitted = direct.length + related.length - chosen.size
  // Changing omitted can add a digit. Never return a response over its budget.
  while (size(result) > maxBytes && result.records.length) {
    chosen.delete(result.records.pop()!.id)
    result.records = result.records.filter(r => !r.via || chosen.has(r.via))
    chosen.clear(); result.records.forEach(r => chosen.add(r.id))
    result.links = result.links.filter(l => chosen.has(l.from) && chosen.has(l.to))
    result.omitted = direct.length + related.length - chosen.size
  }
  if (size(result) > maxBytes) throw new Error('Context retrieval budget is too small for the query and provenance.')
  return result
}
