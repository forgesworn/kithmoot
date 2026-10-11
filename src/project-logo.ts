import { finalizeEvent, generateSecretKey, type Event } from 'nostr-tools/pure'
import { nip44 } from 'nostr-tools'
import type { ParticipantIdentity } from './identity.js'
import { verifyEventUncached } from './verify.js'
import { projectAuthority, projectKey, PROJECT_KIND, PROJECT_WRAP_KIND, type ProjectDefinition, type ProjectIdentity, type ProjectReference } from './projects.js'
import { readLogoImage, type LogoImage } from './logo-image.js'
import { randomFraction } from './random.js'

/** Companion records keep existing strict v1 project directories compatible. */
export const PROJECT_LOGO_APP = 'kithmoot.project-logo.v1'
export const MAX_PROJECT_LOGO_BYTES = 24_576
export const MAX_PROJECT_LOGO_WRAP_BYTES = 50_000
export interface ProjectLogoContext { reference: ProjectReference; definition: ProjectDefinition }
export interface ProjectLogoRecord {
  v: 1
  op: 'logo'
  project: string
  authority: string
  version: number
  request: string
  image: LogoImage | null
}
const encoder = new TextEncoder()
const validTime = (time: number, now: number) => Number.isSafeInteger(time) && time >= 0 && time <= now + 60
const tags = (project: string) => [['d', `logo:${project}`], ['l', PROJECT_LOGO_APP]]

function parseLogo(content: string, context: ProjectLogoContext): ProjectLogoRecord | undefined {
  try {
    projectKey(context.reference)
    if (encoder.encode(content).length > MAX_PROJECT_LOGO_BYTES) return
    const body = JSON.parse(content) as Partial<ProjectLogoRecord>
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
        Object.keys(body).some(key => !['v', 'op', 'project', 'authority', 'version', 'request', 'image'].includes(key)) ||
        body.v !== 1 || body.op !== 'logo' || body.project !== context.reference.project || body.authority !== projectAuthority(context.reference, context.definition) ||
        !Number.isSafeInteger(body.version) || body.version! < 1 || body.version! > 1_000_000 ||
        typeof body.request !== 'string' || !/^[a-zA-Z0-9_-]{16,80}$/.test(body.request)) return
    const image = body.image === null ? null : readLogoImage(body.image)
    if (image === undefined) return
    return { v: 1, op: 'logo', project: body.project, authority: body.authority, version: body.version!, request: body.request, image }
  } catch { return }
}

/** Caller supplies its verified current project directory. A logo record
 * cannot create membership, join a room or change task authority. */
export function projectLogoRecord(event: Event, context: ProjectLogoContext, now = Math.floor(Date.now() / 1000)): ProjectLogoRecord | undefined {
  try {
    if (event.kind !== PROJECT_KIND || event.pubkey !== context.reference.owner || typeof event.content !== 'string' ||
        !validTime(event.created_at, now) || JSON.stringify(event.tags) !== JSON.stringify(tags(context.reference.project)) || !verifyEventUncached(event)) return
    return parseLogo(event.content, context)
  } catch { return }
}

export async function signProjectLogo(identity: ParticipantIdentity, context: ProjectLogoContext,
  record: ProjectLogoRecord, now = Math.floor(Date.now() / 1000)): Promise<Event> {
  if (identity.pubkey !== context.reference.owner) throw new Error('Only the project owner can change its logo')
  const content = JSON.stringify(record)
  if (!Number.isSafeInteger(now) || now < 0 || !parseLogo(content, context)) throw new Error('Invalid project logo update')
  const template = { kind: PROJECT_KIND, created_at: now, tags: tags(context.reference.project), content }
  const signed = await identity.signEvent(template)
  if (signed.content !== template.content || signed.created_at !== template.created_at || !projectLogoRecord(signed, context, now)) {
    throw new Error('The signer changed or refused the project logo')
  }
  return structuredClone(signed)
}

export function wrapProjectLogo(event: Event, recipient: string, context: ProjectLogoContext, now = Math.floor(Date.now() / 1000)): Event {
  if (!projectLogoRecord(event, context, now) || !context.definition.members.some(member => member.pubkey === recipient)) {
    throw new Error('This recipient is not included in the project logo update')
  }
  const ephemeral = generateSecretKey()
  try {
    const content = nip44.v2.encrypt(JSON.stringify(event), nip44.v2.utils.getConversationKey(ephemeral, recipient))
    if (content.length > MAX_PROJECT_LOGO_WRAP_BYTES) throw new Error('The project logo exceeds the transport limit')
    return finalizeEvent({ kind: PROJECT_WRAP_KIND, created_at: Math.max(0, now - Math.floor(randomFraction() * 172800)),
      tags: [['p', recipient], ['l', PROJECT_LOGO_APP]], content }, ephemeral)
  } finally { ephemeral.fill(0) }
}

export async function unwrapProjectLogo(event: Event, identity: ProjectIdentity, context: ProjectLogoContext | readonly ProjectLogoContext[],
  now = Math.floor(Date.now() / 1000)): Promise<Event | undefined> {
  try {
    // A directory supplies only its already-verified current contexts. Decode
    // once, rather than prompting an external signer once for every project.
    const supplied = 'reference' in context ? [context] : context
    const authorised = supplied.filter(candidate => {
      try { projectAuthority(candidate.reference, candidate.definition) } catch { return false }
      return candidate.definition.members.some(member => member.pubkey === identity.pubkey)
    })
    if (!authorised.length ||
        event.kind !== PROJECT_WRAP_KIND || typeof event.content !== 'string' || event.content.length > MAX_PROJECT_LOGO_WRAP_BYTES ||
        !validTime(event.created_at, now) || JSON.stringify(event.tags) !== JSON.stringify([['p', identity.pubkey], ['l', PROJECT_LOGO_APP]]) || !verifyEventUncached(event)) return
    const inner: Event = JSON.parse(await identity.decrypt(event.pubkey, event.content))
    const project = (JSON.parse(inner.content) as Partial<ProjectLogoRecord>).project
    const matching = authorised.find(candidate => candidate.reference.owner === inner.pubkey && candidate.reference.project === project)
    return matching && projectLogoRecord(inner, matching, now) ? structuredClone(inner) : undefined
  } catch { return }
}
