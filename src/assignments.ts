import type { Event } from 'nostr-tools/pure'
import type { ParticipantIdentity } from './identity.js'
import { verifyEventUncached } from './verify.js'
import { sha256 } from '@noble/hashes/sha2'
import { bytesToHex } from '@noble/hashes/utils'

/** Inner events only. Never publish these without the room's encryption. */
export const ASSIGNMENT_KIND = 1464
export const ASSIGNMENT_VERSION = 'kithmoot/assignment/v1'
export const ASSIGNMENT_CHANNEL = 'assignments'
const HEX = /^[0-9a-f]{64}$/
const ID = /^[a-zA-Z0-9_-]{16,80}$/
const MAX_EVENT_BYTES = 16_384

export interface AssignmentAction {
  id: string
  label: string
  description: string
  inputs: { id: string; label: string; required: boolean }[]
}

export type AssignmentOperation =
  | { op: 'create'; objective: string; criteria: string; owner: string; ownerDevice?: string; action?: string; inputs?: Record<string, string> }
  | { op: 'claim'; executor: string; next: string }
  | { op: 'progress'; executor: string; text: string; next: string }
  | { op: 'block'; executor: string; question: string }
  | { op: 'answer'; text: string }
  | { op: 'result'; executor: string; summary: string; evidence: string }
  | { op: 'accept'; result: string }
  | { op: 'reject'; result: string; reason: string }
  | { op: 'stop'; reason: string; purpose: 'cancel' | 'handoff' }
  | { op: 'release'; executor: string; evidence: string }
  | { op: 'assign'; owner: string; ownerDevice?: string; reason: string }

export interface AssignmentPayload {
  v: 1
  assignment: string
  /** Caller-chosen, persisted before publish and reused on retry. */
  request: string
  previous: string | null
  /** Matches the signing device on the encrypted outer envelope. */
  device?: string
  operation: AssignmentOperation
}

export function assignmentId(creator: string, request: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(`${ASSIGNMENT_VERSION}:${creator}:${request}`)))
}

export type AssignmentStatus = 'offered' | 'running' | 'blocked' | 'review' | 'stopping' | 'stopped' | 'accepted' | 'cancelled' | 'conflicted'
export interface Assignment {
  id: string
  room: string
  creator: string
  owner: string
  ownerDevice?: string
  objective: string
  criteria: string
  action?: string
  inputs?: Record<string, string>
  status: AssignmentStatus
  head: string
  attempt: number
  executor?: string
  next: string
  progress: string
  question?: string
  answer?: string
  result?: { id: string; summary: string; evidence: string }
  stop?: { purpose: 'cancel' | 'handoff'; reason: string }
  history: { id: string; by: string; at: number; operation: AssignmentOperation }[]
}

function record(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}
function text(v: unknown, max = 2000): v is string {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= max
}
function hex(v: unknown): v is string { return typeof v === 'string' && HEX.test(v) }
function id(v: unknown): v is string { return typeof v === 'string' && ID.test(v) }
function keys(v: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(v).every(k => allowed.includes(k))
}

/** Strict allowlists make the sharing projection an enforceable boundary. */
export function validAssignmentOperation(v: unknown): v is AssignmentOperation {
  if (!record(v)) return false
  switch (v.op) {
    case 'create':
      return keys(v, ['op', 'objective', 'criteria', 'owner', 'ownerDevice', 'action', 'inputs']) &&
        text(v.objective, 1000) && text(v.criteria, 2000) && hex(v.owner) &&
        (v.ownerDevice === undefined || hex(v.ownerDevice)) &&
        (v.action === undefined || text(v.action, 64)) &&
        (v.inputs === undefined || (record(v.inputs) && Object.keys(v.inputs).length <= 8 &&
          Object.entries(v.inputs).every(([k, value]) => /^[a-z][a-z0-9_-]{0,31}$/.test(k) && text(value, 1000))))
    case 'claim': return keys(v, ['op', 'executor', 'next']) && id(v.executor) && text(v.next)
    case 'progress': return keys(v, ['op', 'executor', 'text', 'next']) && id(v.executor) && text(v.text) && text(v.next)
    case 'block': return keys(v, ['op', 'executor', 'question']) && id(v.executor) && text(v.question)
    case 'answer': return keys(v, ['op', 'text']) && text(v.text)
    case 'result': return keys(v, ['op', 'executor', 'summary', 'evidence']) && id(v.executor) && text(v.summary) && text(v.evidence, 6000)
    case 'accept': return keys(v, ['op', 'result']) && hex(v.result)
    case 'reject': return keys(v, ['op', 'result', 'reason']) && hex(v.result) && text(v.reason)
    case 'stop': return keys(v, ['op', 'reason', 'purpose']) && text(v.reason) && ['cancel', 'handoff'].includes(v.purpose as string)
    case 'release': return keys(v, ['op', 'executor', 'evidence']) && id(v.executor) && text(v.evidence)
    case 'assign': return keys(v, ['op', 'owner', 'ownerDevice', 'reason']) && hex(v.owner) && text(v.reason) && (v.ownerDevice === undefined || hex(v.ownerDevice))
    default: return false
  }
}

export function assignmentPayload(event: Event, room: string): AssignmentPayload | undefined {
  try {
    if (!HEX.test(room) || event.kind !== ASSIGNMENT_KIND ||
        JSON.stringify(event.tags) !== JSON.stringify([['d', ASSIGNMENT_VERSION], ['room', room]]) ||
        new TextEncoder().encode(event.content).length > MAX_EVENT_BYTES || !verifyEventUncached(event)) return
    const p: unknown = JSON.parse(event.content)
    if (!record(p) || !keys(p, ['v', 'assignment', 'request', 'previous', 'device', 'operation']) || p.v !== 1 ||
        (p.device !== undefined && !hex(p.device)) ||
        !id(p.assignment) || !id(p.request) || (p.previous !== null && !hex(p.previous)) ||
        !validAssignmentOperation(p.operation)) return
    if ((p.operation.op === 'create') !== (p.previous === null)) return
    if (p.operation.op === 'create' && p.assignment !== assignmentId(event.pubkey, p.request)) return
    return p as unknown as AssignmentPayload
  } catch { return }
}

export async function signAssignment(identity: ParticipantIdentity, room: string, payload: AssignmentPayload, at = Math.floor(Date.now() / 1000)): Promise<Event> {
  const unsigned = { kind: ASSIGNMENT_KIND, created_at: at, tags: [['d', ASSIGNMENT_VERSION], ['room', room]], content: JSON.stringify(payload) }
  const event = await identity.signEvent(unsigned)
  if (event.pubkey !== identity.pubkey || event.content !== unsigned.content || !assignmentPayload(event, room)) {
    throw new Error('The signer changed or refused the assignment.')
  }
  return event
}

function transition(before: Assignment | undefined, event: Event, p: AssignmentPayload, room: string): Assignment | undefined {
  const op = p.operation
  if (!before) {
    if (op.op !== 'create') return
    return {
      id: p.assignment, room, creator: event.pubkey, owner: op.owner,
      ...(op.ownerDevice ? { ownerDevice: op.ownerDevice } : {}),
      objective: op.objective, criteria: op.criteria,
      ...(op.action ? { action: op.action } : {}), ...(op.inputs ? { inputs: op.inputs } : {}),
      status: 'offered', head: event.id, attempt: 1, next: 'Waiting for the owner to start', progress: '',
      history: [{ id: event.id, by: event.pubkey, at: event.created_at, operation: op }],
    }
  }
  if (p.previous !== before.head || ['accepted', 'cancelled', 'conflicted'].includes(before.status)) return
  const s = structuredClone(before)
  const creator = event.pubkey === s.creator
  const owner = event.pubkey === s.owner
  const executor = owner && 'executor' in op && op.executor === s.executor
  switch (op.op) {
    case 'create': return
    case 'claim':
      if (!owner || s.status !== 'offered' || (s.ownerDevice && p.device !== s.ownerDevice)) return
      s.status = 'running'; s.executor = op.executor; s.next = op.next
      break
    case 'progress':
      if (!executor || s.status !== 'running') return
      s.progress = op.text; s.next = op.next
      break
    case 'block':
      if (!executor || s.status !== 'running') return
      s.status = 'blocked'; s.question = op.question; s.next = 'Waiting for an answer'
      break
    case 'answer':
      if (!creator || s.status !== 'blocked') return
      s.status = 'running'; s.answer = op.text; delete s.question; s.next = 'Continue with the answer'
      break
    case 'result':
      if (!executor || s.status !== 'running') return
      s.status = 'review'; s.result = { id: event.id, summary: op.summary, evidence: op.evidence }; s.next = 'Review the result'
      break
    case 'accept':
      if (!creator || s.status !== 'review' || s.result?.id !== op.result) return
      s.status = 'accepted'; s.next = 'Result accepted'
      break
    case 'reject':
      if (!creator || s.status !== 'review' || s.result?.id !== op.result) return
      s.status = 'offered'; s.attempt++; s.next = op.reason; delete s.executor; delete s.result
      break
    case 'stop':
      if (!creator || s.status === 'stopping' || s.status === 'stopped') return
      s.stop = { purpose: op.purpose, reason: op.reason }
      s.status = ['offered', 'review'].includes(s.status)
        ? (op.purpose === 'cancel' ? 'cancelled' : 'stopped') : 'stopping'
      s.next = s.status === 'stopping' ? 'Waiting for the owner to confirm work has stopped' : op.reason
      break
    case 'release':
      if (!executor || s.status !== 'stopping') return
      s.status = s.stop?.purpose === 'cancel' ? 'cancelled' : 'stopped'
      s.progress = op.evidence; s.next = s.status === 'cancelled' ? 'Cancelled; execution stopped' : 'Choose the next owner'
      break
    case 'assign':
      if (!creator || s.status !== 'stopped' || s.stop?.purpose !== 'handoff') return
      s.owner = op.owner; s.attempt++; s.status = 'offered'; s.next = op.reason
      if (op.ownerDevice) s.ownerDevice = op.ownerDevice; else delete s.ownerDevice
      delete s.executor; delete s.stop; delete s.question; delete s.answer; delete s.result
      break
  }
  s.head = event.id
  s.history.push({ id: event.id, by: event.pubkey, at: event.created_at, operation: op })
  return s
}

export interface AssignmentProjection {
  assignments: Assignment[]
  /** Authentic operations whose predecessor has not arrived. Do not run them. */
  pending: string[]
  rejected: string[]
}

/** Arrival order is irrelevant. Conflicting authorised branches halt execution.
 * A timestamp is a display fact, never a lease or permission to take over. */
export function projectAssignments(events: readonly Event[], room: string): AssignmentProjection {
  const groups = new Map<string, { event: Event; payload: AssignmentPayload }[]>()
  const rejected: string[] = []
  const seen = new Set<string>()
  for (const event of events) {
    if (seen.has(event.id)) continue
    seen.add(event.id)
    const payload = assignmentPayload(event, room)
    if (!payload) { rejected.push(event.id); continue }
    const group = groups.get(payload.assignment) ?? []
    group.push({ event, payload }); groups.set(payload.assignment, group)
  }
  const assignments: Assignment[] = []
  const pending: string[] = []
  for (const group of groups.values()) {
    const remaining = new Map(group.map(x => [x.event.id, x]))
    let current: Assignment | undefined
    const requests = new Map<string, string>()
    while (remaining.size) {
      const candidates: { state: Assignment; event: Event; payload: AssignmentPayload }[] = []
      for (const { event, payload } of remaining.values()) {
        if (payload.previous !== (current?.head ?? null)) continue
        const state = transition(current, event, payload, room)
        if (!state || requests.has(`${event.pubkey}:${payload.request}`)) {
          rejected.push(event.id); remaining.delete(event.id); continue
        }
        candidates.push({ state, event, payload })
      }
      if (!candidates.length) break
      if (candidates.length > 1) {
        // Keep a stable display, but give no branch execution authority.
        candidates.sort((a, b) => a.event.id.localeCompare(b.event.id))
        current = { ...(current ?? candidates[0]!.state), status: 'conflicted', next: 'Conflicting updates; execution must stop for reconciliation' }
        for (const c of candidates) remaining.delete(c.event.id)
        break
      }
      const c = candidates[0]!
      current = c.state
      requests.set(`${c.event.pubkey}:${c.payload.request}`, c.event.id)
      remaining.delete(c.event.id)
    }
    if (current) assignments.push(current)
    pending.push(...remaining.keys())
  }
  return { assignments: assignments.sort((a, b) => a.id.localeCompare(b.id)), pending, rejected }
}

export function assignmentHumanAction(s: Assignment): string | undefined {
  switch (s.status) {
    case 'blocked': return `Answer: ${s.question}`
    case 'review': return `Review: ${s.objective}`
    case 'stopped': return `Choose the next owner: ${s.objective}`
    case 'conflicted': return `Resolve conflicting updates: ${s.objective}`
    default: return undefined
  }
}

export function validateAssignmentActions(raw: unknown): AssignmentAction[] | undefined {
  if (!Array.isArray(raw) || raw.length > 8) return
  const ids = new Set<string>()
  for (const a of raw) {
    if (!record(a) || !keys(a, ['id', 'label', 'description', 'inputs']) || !text(a.id, 64) || ids.has(a.id) ||
        !text(a.label, 80) || !text(a.description, 300) || !Array.isArray(a.inputs) || a.inputs.length > 8) return
    ids.add(a.id)
    const inputIds = new Set<string>()
    for (const i of a.inputs) {
      if (!record(i) || !keys(i, ['id', 'label', 'required']) || typeof i.id !== 'string' ||
          !/^[a-z][a-z0-9_-]{0,31}$/.test(i.id) || inputIds.has(i.id) || !text(i.label, 80) || typeof i.required !== 'boolean') return
      inputIds.add(i.id)
    }
  }
  return structuredClone(raw) as AssignmentAction[]
}

export function validateActionInputs(action: AssignmentAction, values: Record<string, string>): boolean {
  return Object.keys(values).every(k => action.inputs.some(i => i.id === k) && text(values[k], 1000)) &&
    action.inputs.every(i => !i.required || text(values[i.id], 1000))
}
