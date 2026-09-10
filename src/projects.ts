import { finalizeEvent, generateSecretKey, type Event } from 'nostr-tools/pure'
import { nip44 } from 'nostr-tools'
import { bytesToHex } from '@noble/hashes/utils'
import { sha256 } from '@noble/hashes/sha2'
import type { ParticipantIdentity } from './identity.js'
import type { PeerCrypt } from './dm.js'
import { parseRoomLink } from './link.js'
import { sanitiseDisplayName } from './display-name.js'
import { verifyEventUncached } from './verify.js'

export const PROJECT_APP = 'kithmoot.projects.v1'
export const PROJECT_KIND = 30078
export const PROJECT_WRAP_KIND = 1059
export const MAX_PROJECT_BYTES = 32_768
export const MAX_PROJECT_WRAP_BYTES = 100_000
const hex = /^[0-9a-f]{64}$/
const requestId = /^[a-zA-Z0-9_-]{16,80}$/
const encoder = new TextEncoder()

export interface ProjectIdentity extends ParticipantIdentity, PeerCrypt {}
export interface ProjectMember { pubkey: string; kind: 'person' | 'agent'; name?: string; epoch: number }
export interface ProjectRoom { room: string; name: string; link: string }
/** A directory of deliberately shared collaborators and room invitations.
 * This is not a room admission, model/tool grant or execution mandate. */
export interface ProjectDefinition {
  name: string
  members: ProjectMember[]
  rooms: ProjectRoom[]
  archived: boolean
  authorityRevision: number
}
export interface ProjectReference { owner: string; project: string }
export interface ProjectRevision extends ProjectReference { head: string; revision: number; authority: string }
interface RecordBase { v: 1; project: string; revision: number; request: string; parents: string[] }
export type ProjectRecord =
  | (RecordBase & { op: 'snapshot'; definition: ProjectDefinition })
  | (RecordBase & { op: 'withdraw'; recipient: string })
  | (RecordBase & { op: 'follow'; owner: string; joined: boolean; membership: number; invitation: string })

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
function exact(value: Record<string, unknown>, fields: string[]): boolean {
  return Object.keys(value).every(k => fields.includes(k))
}
function label(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 64 && sanitiseDisplayName(value) === value
}
function revision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= 1_000_000
}
function validDefinition(value: unknown, owner: string): value is ProjectDefinition {
  if (!object(value) || !exact(value, ['name', 'members', 'rooms', 'archived', 'authorityRevision']) || !label(value.name) ||
      typeof value.archived !== 'boolean' || !revision(value.authorityRevision) || !Array.isArray(value.members) || !value.members.length || value.members.length > 64 ||
      !Array.isArray(value.rooms) || value.rooms.length > 32) return false
  const members = new Set<string>(), rooms = new Set<string>()
  for (const m of value.members) {
    if (!object(m) || !exact(m, ['pubkey', 'kind', 'name', 'epoch']) || typeof m.pubkey !== 'string' || !hex.test(m.pubkey) ||
        members.has(m.pubkey) || !revision(m.epoch) || m.kind !== 'person' && m.kind !== 'agent' || m.name !== undefined && !label(m.name)) return false
    members.add(m.pubkey)
  }
  if (!members.has(owner)) return false
  for (const r of value.rooms) {
    if (!object(r) || !exact(r, ['room', 'name', 'link']) || typeof r.room !== 'string' || !hex.test(r.room) || rooms.has(r.room) ||
        !label(r.name) || typeof r.link !== 'string' || r.link.length > 4096) return false
    try {
      // A room invitation is deliberate sharing. Traffic keys and credentials
      // are not accepted here, nor can a project invent a room's admission.
      const link = parseRoomLink(r.link)
      const url = new URL(r.link)
      if (url.protocol !== 'https:' || url.username || url.password || !link.invitation || !link.invitation.persistent || link.pairingCode) return false
    } catch { return false }
    rooms.add(r.room)
  }
  return true
}

export function projectKey(ref: ProjectReference): string {
  if (!hex.test(ref.owner) || !hex.test(ref.project)) throw new Error('Invalid project reference')
  return `${ref.owner}:${ref.project}`
}
export function projectId(owner: string, request: string): string {
  if (!hex.test(owner) || !requestId.test(request)) throw new Error('Invalid project creation request')
  return bytesToHex(sha256(encoder.encode(`${PROJECT_APP}:${owner}:${request}`)))
}
/** Names and invitation refreshes do not silently change execution authority.
 * A host may pin this eligibility digest alongside its own project mandate;
 * the digest itself grants no access to rooms, history, tools or context. */
export function projectAuthority(ref: ProjectReference, definition: ProjectDefinition): string {
  projectKey(ref)
  if (!validDefinition(definition, ref.owner)) throw new Error('Invalid shared project')
  return bytesToHex(sha256(encoder.encode(JSON.stringify({ app: PROJECT_APP, owner: ref.owner, project: ref.project, archived: definition.archived, authorityRevision: definition.authorityRevision,
    members: definition.members.map(m => ({ pubkey: m.pubkey, kind: m.kind, epoch: m.epoch })).sort((a, b) => a.pubkey.localeCompare(b.pubkey)),
    rooms: definition.rooms.map(r => r.room).sort(),
  }))))
}

export function projectRecord(event: Event, now = Math.floor(Date.now() / 1000)): ProjectRecord | undefined {
  try {
    if (event.kind !== PROJECT_KIND || typeof event.content !== 'string' || encoder.encode(event.content).length > MAX_PROJECT_BYTES ||
        !Number.isSafeInteger(event.created_at) || event.created_at < 0 || event.created_at > now + 60 || !verifyEventUncached(event)) return
    const p: unknown = JSON.parse(event.content)
    if (!object(p) || p.v !== 1 || typeof p.project !== 'string' || !hex.test(p.project) ||
        !revision(p.revision) || typeof p.request !== 'string' || !requestId.test(p.request) ||
        !Array.isArray(p.parents) || p.parents.length > 8 || p.parents.some(h => typeof h !== 'string' || !hex.test(h)) ||
        new Set(p.parents).size !== p.parents.length || (p.revision === 1 ? p.parents.length !== 0 : p.parents.length === 0) ||
        JSON.stringify(event.tags) !== JSON.stringify([['d', p.project], ['l', PROJECT_APP]])) return
    const fields = ['v', 'project', 'revision', 'request', 'parents', 'op'], revisionValue = p.revision
    if (p.op === 'snapshot' && exact(p, [...fields, 'definition']) && validDefinition(p.definition, event.pubkey) && p.definition.authorityRevision <= revisionValue && p.definition.members.every(m => m.epoch <= revisionValue)) return p as unknown as ProjectRecord
    if (p.op === 'withdraw' && exact(p, [...fields, 'recipient']) && typeof p.recipient === 'string' && hex.test(p.recipient) && p.recipient !== event.pubkey) return p as unknown as ProjectRecord
    if (p.op === 'follow' && exact(p, [...fields, 'owner', 'joined', 'membership', 'invitation']) && typeof p.owner === 'string' && hex.test(p.owner) && typeof p.joined === 'boolean' && revision(p.membership) && typeof p.invitation === 'string' && hex.test(p.invitation)) return p as unknown as ProjectRecord
  } catch { /* Invalid signatures or hostile input never become a project. */ }
}

export async function signProject(identity: ParticipantIdentity, record: ProjectRecord, now = Math.floor(Date.now() / 1000)): Promise<Event> {
  const template = { kind: PROJECT_KIND, created_at: now, tags: [['d', record.project], ['l', PROJECT_APP]], content: JSON.stringify(record) }
  if (encoder.encode(template.content).length > MAX_PROJECT_BYTES) throw new Error('The project exceeds the shared directory size limit')
  const signed = await identity.signEvent(template)
  if (signed.pubkey !== identity.pubkey || signed.kind !== template.kind || signed.created_at !== template.created_at ||
      signed.content !== template.content || JSON.stringify(signed.tags) !== JSON.stringify(template.tags) || !projectRecord(signed, now)) throw new Error('The signer changed or refused the project update')
  return structuredClone(signed)
}

export function projectForRecipient(event: Event, recipient: string, now?: number): ProjectRecord | undefined {
  const p = projectRecord(event, now)
  if (!p) return
  if (p.op === 'snapshot') return p.definition.members.some(m => m.pubkey === recipient) ? p : undefined
  if (p.op === 'withdraw') return p.recipient === recipient ? p : undefined
  return event.pubkey === recipient ? p : undefined
}

/** NIP-59 permits a gift wrap around any signed event. This application wraps
 * its signed directory record directly; it does not claim NIP-17 DM semantics.
 * The relay sees the app label and recipient, but no project, owner or rooms. */
export function wrapProject(event: Event, recipient: string, now = Math.floor(Date.now() / 1000)): Event {
  if (!hex.test(recipient) || !projectForRecipient(event, recipient, now)) throw new Error('This recipient is not included in the project update')
  const ephemeral = generateSecretKey()
  try {
    const content = nip44.v2.encrypt(JSON.stringify(event), nip44.v2.utils.getConversationKey(ephemeral, recipient))
    if (content.length > MAX_PROJECT_WRAP_BYTES) throw new Error('The encrypted project exceeds the transport limit')
    return finalizeEvent({ kind: PROJECT_WRAP_KIND, created_at: Math.max(0, now - Math.floor(Math.random() * 172800)),
      tags: [['p', recipient], ['l', PROJECT_APP]], content }, ephemeral)
  } finally { ephemeral.fill(0) }
}
export async function unwrapProject(event: Event, identity: ProjectIdentity, now = Math.floor(Date.now() / 1000)): Promise<Event | undefined> {
  try {
    if (event.kind !== PROJECT_WRAP_KIND || typeof event.content !== 'string' || event.content.length > MAX_PROJECT_WRAP_BYTES ||
        !verifyEventUncached(event) || JSON.stringify(event.tags) !== JSON.stringify([['p', identity.pubkey], ['l', PROJECT_APP]])) return
    const inner: Event = JSON.parse(await identity.decrypt(event.pubkey, event.content))
    return projectForRecipient(inner, identity.pubkey, now) ? structuredClone(inner) : undefined
  } catch { return }
}
