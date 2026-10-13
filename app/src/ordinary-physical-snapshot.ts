import { OrdinaryStateHold, ORDINARY_NAME_UNITS, ORDINARY_RECORDS, ORDINARY_IMAGE_BYTES, ordinaryUtf8Length } from './ordinary-state-codec.js'

const H = '[0-9a-f]{64}', A = `(?:visitor|${H})`, wrap = `(?:kithmoot\\.account\\.${H}\\.)?`
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const signals = ['kithmoot-mls-vault-v1.revision', 'kithmoot.mls-coordinated-vault.revision', 'kithmoot-rendezvous-vault-v1:revision']
const marker = 'kithmoot.ordinary-tab.v1'
export const ORDINARY_PHYSICAL_FAMILIES = Object.freeze(['signet', 'identity', 'access', 'invitationProofs', 'epoch', 'bookmarks', 'quiet', 'cadence', 'pending',
  'contacts', 'grantedContacts', 'metadata', 'channelChecks', 'journals', 'private', 'media', 'routing', 'ui', 'navigation', 'entryLayout',
  'appearance', 'callCoordination', 'signal', 'tabMarker'] as const)
export type OrdinaryPhysicalFamily = typeof ORDINARY_PHYSICAL_FAMILIES[number]
export type OrdinaryPhysicalKind = 'browser' | 'tab'
export interface OrdinaryPhysicalClassification { readonly family: OrdinaryPhysicalFamily; readonly custody: 'protected' | 'signal' | 'tab-marker' }
function hold(): never { throw new OrdinaryStateHold() }
/** Select the reserved roots, including unknown future names, not a finite
 * allowlist that could leave new private state in plaintext. Unrelated origin
 * records are left alone. Namespace aliases inside these roots HOLD below. */
export function ordinaryPrivateStorageName(name: string): boolean { return /^(?:kithmoot(?:[.:-]|$)|signet:login(?:[.:-]|$))/.test(name) }
interface Rule { family: OrdinaryPhysicalFamily; pattern: RegExp; kinds: readonly OrdinaryPhysicalKind[] }
const rules: Rule[] = []
function add(family: OrdinaryPhysicalFamily, source: string, kinds: readonly OrdinaryPhysicalKind[] = ['browser']): void {
  rules.push({ family, pattern: new RegExp('^(?:' + source + ')$'), kinds })
}
const exact = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const names = (family: OrdinaryPhysicalFamily, values: readonly string[], kinds?: readonly OrdinaryPhysicalKind[]) => add(family, values.map(exact).join('|'), kinds)
add('identity', 'kithmoot\\.participant')
add('identity', wrap + `kithmoot\\.(?:device|credential|own-credential|own-seal)\\.${H}`)
add('identity', `kithmoot\\.account\\.${H}\\.kithmoot\\.device-owner\\.${H}`)
add('access', wrap + `kithmoot\\.room\\.${H}`)
add('access', wrap + `kithmoot\\.(?:invitation-owner|admission-kept)\\.v1\\.${H}`)
add('access', wrap + `kithmoot\\.admission\\.v1\\.${H}`, ['tab'])
add('invitationProofs', `kithmoot\\.account\\.${H}\\.kithmoot\\.invitation-proof\\.v1\\.${H}\\.${H}`)
add('invitationProofs', `kithmoot\\.account\\.${H}\\.kithmoot\\.admission-proof\\.v1\\.${H}`, ['tab'])
add('invitationProofs', `kithmoot\\.account\\.${H}\\.kithmoot\\.(?:invitation-creator|invitation-publication)\\.v1\\.${H}`)
add('epoch', wrap + `kithmoot\\.room-epoch\\.v[12]\\.${H}`)
add('bookmarks', `kithmoot\\.bookmarks\\.${H}\\.${H}`)
add('quiet', wrap + `kithmoot\\.quiet\\.v1\\.${H}`)
add('cadence', wrap + `kithmoot\\.cadence-lease\\.v1\\.${H}\\.${H}\\.[0-9a-f]{32}\\.[1-9][0-9]*`)
add('pending', `kithmoot\\.account\\.${H}\\.kithmoot\\.pending\\.${H}`, ['browser', 'tab'])
add('contacts', `kithmoot\\.contact\\.v1\\.${H}|kithmoot\\.rendezvous\\.v1|kithmoot\\.verified\\.${H}|kithmoot\\.checks\\.v2\\.${H}\\.kithmoot\\.verified\\.${H}`)
add('grantedContacts', `kithmoot\\.contacts\\.v2\\.${H}\\.(?:pairing|signet-contacts:(?:state|pending):[0-9a-f]{32})`)
add('metadata', `kithmoot\\.volume\\.v1\\.${H}|kithmoot\\.pinned-rooms\\.v1|kithmoot\\.project\\.v1\\.${A}\\.${H}`)
add('channelChecks', `kithmoot\\.channel-checks\\.v1\\.${H}\\.${H}`)
add('journals', `kithmoot\\.(?:shared-projects|context)\\.v1\\.${H}|kithmoot\\.assignments\\.v1\\.${H}\\.${H}`)
add('private', `kithmoot\\.(?:box-discovery|history-recovery)\\.v1\\.${H}\\.${H}|kithmoot\\.(?:uploads|room-logo)\\.v1\\.${H}|kithmoot\\.(?:blob-deletes|file-storage)\\.v1|kithmoot\\.blossom-server`)
names('media', ['kithmoot.call.effectMode', 'kithmoot.call.background', 'kithmoot.call.blurStrength', 'kithmoot.call.voicePreset', 'kithmoot.call.cameraDeviceId', 'kithmoot.call.micDeviceId'])
names('media', ['kithmoot.callProfile'], ['browser', 'tab'])
add('routing', `kithmoot\\.(?:relays|circle|room-relays-fixed)\\.v1|kithmoot\\.room-relays\\.v1\\.${H}`)
names('ui', ['kithmoot.mirror-self', 'kithmoot.fish.enabled', 'kithmoot.camera.framing', 'kithmoot.agents-hear', 'kithmoot.zen-bell', 'kithmoot.desktop-bell', 'kithmoot.profiles.enabled',
  'kithmoot.name', 'kithmoot.last-nostr-account', 'kithmoot.last-nostr-method', 'kithmoot.profiles.lastKnownName.v1', 'kithmoot.send-delay', 'kithmoot.destructed.v1', 'kithmoot:emoji:skinTone', 'kithmoot:emoji:recents'])
add('ui', `kithmoot\\.room-name\\.v1\\.${H}|kithmoot\\.(?:nudge|destruct-heads-up)\\.${H}|kithmoot\\.home\\.fold\\.(?:pinned|unread|recent|older|other|ended)`)
names('ui', ['kithmoot.notice'], ['tab'])
names('navigation', ['kithmoot.way-back', 'kithmoot.room-switch.v1'], ['tab'])
names('entryLayout', ['kithmoot.notify', 'kithmoot.notify-text', 'kithmoot.call-chat-panel', 'kithmoot.call-chat-divider', 'kithmoot.call-view', 'kithmoot.call-self-corner', 'kithmoot.call-hide-self', 'kithmoot.call-hide-no-video',
  'kithmoot.desktopChatDrawerOpen', 'kithmoot.desktopProjectsRailOpen', 'kithmoot.desktopProjectsRailWidth'])
add('entryLayout', `kithmoot\\.(?:knock|invited)\\.v1\\.${H}`)
add('entryLayout', `kithmoot\\.conversation\\.v1\\.${A}\\.(?:${H}|undefined)`, ['tab'])
names('appearance', ['kithmoot.textSize'])
names('callCoordination', ['kithmoot.call-tab-lock.msg'])

function notificationName(name: string): boolean {
  const prefix = 'kithmoot.notification-scopes.v1.'
  if (!name.startsWith(prefix)) return false
  const raw = name.slice(prefix.length), v: unknown = JSON.parse(raw)
  if (JSON.stringify(v) !== raw || !Array.isArray(v) || v.length !== 3 || typeof v[0] !== 'string' || !new RegExp(`^${A}$`).test(v[0]) ||
      !['default', 'project', 'room'].includes(v[1]) || typeof v[2] !== 'string' ||
      (v[1] === 'default' ? v[2] !== '' : !v[2]) || v[1] === 'room' && !/^[0-9a-f]{64}$/.test(v[2])) hold()
  return true
}
const signetKeys = ['pubkey', 'method', 'authEvent', 'bunkerUri', 'bunkerClientSk', 'expiresAt', 'displayName', 'clientSk', 'pendingRedirect', 'pendingRelayAuth']
// Signet is its own family, without exposing its key/value or a live session.
export type OrdinaryPhysicalRoute = OrdinaryPhysicalClassification
/** Exact name + physical-owner routing, not whole value or authority validation.
 * No name is dispatched twice. Every protected route must subsequently pass
 * its strict family validator and the complete same-image binding checks. */
export function classifyOrdinaryPhysicalName(name: string, kind: OrdinaryPhysicalKind): OrdinaryPhysicalRoute | undefined {
  try {
    if (!['browser', 'tab'].includes(kind) || typeof name !== 'string') hold()
    if (!ordinaryPrivateStorageName(name)) return undefined
    if (!name.length || name.length > ORDINARY_NAME_UNITS) hold()
    if (signals.includes(name)) { if (kind !== 'browser') hold(); return Object.freeze({ family: 'signal', custody: 'signal' }) }
    if (name === marker) { if (kind !== 'tab') hold(); return Object.freeze({ family: 'tabMarker', custody: 'tab-marker' }) }
    if (signetKeys.some(k => name === 'signet:login.' + k)) { if (kind !== 'browser') hold(); return Object.freeze({ family: 'signet', custody: 'protected' }) }
    if (notificationName(name)) { if (kind !== 'browser') hold(); return Object.freeze({ family: 'metadata', custody: 'protected' }) }
    const matched = rules.filter(rule => rule.pattern.test(name))
    if (matched.length !== 1 || !matched[0]!.kinds.includes(kind)) hold()
    return Object.freeze({ family: matched[0]!.family, custody: 'protected' })
  } catch { return hold() }
}
function specialValue(family: OrdinaryPhysicalRoute['family'], raw: string): void {
  if (family === 'signal') { if (!UUID.test(raw)) hold() }
  else if (family === 'tabMarker') { if (!/^[0-9a-f]{64}$/.test(raw)) hold() }
  else if (family === 'appearance') { if (!['standard', 'large', 'huge'].includes(raw)) hold() }
  else if (family === 'callCoordination') {
    const v: unknown = JSON.parse(raw)
    const object = (o: unknown, fields: string[]): o is Record<string, unknown> => !!o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).join(',') === fields.join(',')
    if (JSON.stringify(v) !== raw || !object(v, ['message', 'at', 'r']) || !object(v.message, ['t', 'key', 'tab']) ||
        !['claim', 'release', 'probe'].includes(v.message.t as string) || typeof v.message.key !== 'string' ||
        typeof v.message.tab !== 'string' || !UUID.test(v.message.tab) || !Number.isSafeInteger(v.at) || (v.at as number) < 0 ||
        typeof v.r !== 'number' || !Number.isFinite(v.r) || v.r < 0 || v.r >= 1) hold()
    // Callable lock methods can persist empty/long opaque keys. Retain only
    // as inert metadata; current isMessage may ignore them. No call decision.
  }
}
/** Count-only physical preflight. This proves routing, bounds and exact special
 * values, not the semantic validity of ordinary family rows. No loader, clock,
 * key creation, tab allocation, storage write, effect or cleanup runs here. */
export function validateOrdinaryPhysicalSnapshot(records: ReadonlyMap<string, string>, options: { kind: OrdinaryPhysicalKind }):
  Readonly<{ protectedRecords: number; signals: number; tabMarkers: number; families: Readonly<Partial<Record<OrdinaryPhysicalRoute['family'], number>>> }> {
  try {
    const kind = options.kind
    if (!['browser', 'tab'].includes(kind)) hold()
    const snapshot = new Map(records)
    const families: Partial<Record<OrdinaryPhysicalRoute['family'], number>> = {}, c = { protectedRecords: 0, signals: 0, tabMarkers: 0 }
    let bytes = 0
    for (const [name, raw] of snapshot) {
      const route = classifyOrdinaryPhysicalName(name, kind)
      if (!route) continue
      if (typeof raw !== 'string') hold()
      const size = ordinaryUtf8Length(raw)
      families[route.family] = (families[route.family] ?? 0) + 1
      if (route.custody === 'protected') {
        c.protectedRecords++; bytes += size + ordinaryUtf8Length(name)
        if (c.protectedRecords > ORDINARY_RECORDS || bytes > ORDINARY_IMAGE_BYTES) hold()
      } else if (route.custody === 'signal') c.signals++
      else c.tabMarkers++
    }
    // Check the entire prospective image before parsing any value, including
    // call coordination. The authenticated frame has its own encoding ceiling.
    for (const [name, raw] of snapshot) {
      const route = classifyOrdinaryPhysicalName(name, kind)
      if (route) specialValue(route.family, raw)
    }
    return Object.freeze({ ...c, families: Object.freeze(families) })
  } catch { return hold() }
}
