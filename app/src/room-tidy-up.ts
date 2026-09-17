/**
 * Leave a room and remove what this person left on its relays, as far as
 * NIP-09 allows.
 *
 * Learned by doing it by hand for a real room on 14 September 2026:
 *
 * - Order matters. The group invitation and retirement notice are signed by
 *   the link keys, and New link or Forget throws those keys away. They go
 *   first, while the keys still exist.
 * - A retirement notice is what stops an old link opening the room. It is
 *   deleted only when every relay has accepted deleting the invitation and
 *   none still returns it; otherwise the notice stays and the report says why.
 * - Some relays honour a kind 5 naming an addressable record only by its
 *   `e` id, others only by its `a` address. Both are sent.
 * - A second tab in the room keeps publishing under the same device key, so
 *   every tab leaves first, or nothing is deleted.
 *
 * A deletion request is a request. An accepting relay may still keep a copy,
 * other relays and members may have copied it already, and other members'
 * events are theirs. The report says what was asked, each relay's answer,
 * and what a fresh query still finds.
 */
import { finalizeEvent, getPublicKey, type Event, type EventTemplate } from 'nostr-tools/pure'
import type { Filter } from 'nostr-tools/filter'
import type { HistoryReadResult } from '../../src/history-import.js'
import type { PublicDeletionRelayOutcome } from './public-deletion-relay-writer.js'
import { KINDS } from '../../src/kinds.js'

export type TidyStepId = 'end' | 'invitations' | 'retirement' | 'tabs' | 'device' | 'bookmark' | 'account' | 'local' | 'check'

export interface TidyStep { id: TidyStepId; label: string }

export interface TidyStepReport {
  id: TidyStepId
  label: string
  /** Events found to delete, across every relay asked. */
  found: number
  /** Each relay's answer to the deletion request, when one was sent. */
  answers: PublicDeletionRelayOutcome[]
  /** Relays that could not be asked what they hold. */
  unread: string[]
  /** Why the step did not run, when it did not. */
  skipped?: string
}

export interface TidyRemaining { what: string; relay: string; count: number }

export interface TidyUpReport {
  steps: TidyStepReport[]
  /** What a fresh query still finds, by relay. */
  remaining: TidyRemaining[]
  /** Set when the tidy-up stopped before deleting anything. */
  refused?: string
}

/** What nobody can delete, said every time. */
export const TIDY_UP_LIMITS = [
  'Other members’ messages and roster entries are theirs, and stay.',
  'Anything a member, a relay or anybody else already copied stays with them.',
  'A relay that accepts a deletion request may still keep a copy.',
]

export interface TidyUpDeps {
  now: () => number
  /** Relays the room's own events went to. */
  roomRelays: readonly string[]
  /** Relays the account's records went to. */
  accountRelays: readonly string[]
  read: (relay: string, filter: Filter) => Promise<HistoryReadResult>
  publish: (relays: readonly string[], event: Event) => Promise<PublicDeletionRelayOutcome[]>
  /** The link keys, when this browser started the room. */
  inviter?: { sk: Uint8Array; invitationId: string }
  device: { sk: Uint8Array }
  /** The signed-in account, when there is one. */
  account?: {
    pubkey: string
    sign: (template: EventTemplate) => Promise<Event>
    /** The read-position record's `d`, when this browser holds the room key. */
    readPositionD?: string
    /** Forget the room's bookmark with a signed tombstone. Resolves with
     *  the tombstone's `d` once a relay has accepted it, if one did. */
    forgetBookmark: () => Promise<string | undefined>
    deleteTombstone: boolean
  }
  /** End the room for everyone first, when this browser can and was asked to. */
  endRoom?: () => Promise<void>
  /** Ask every other tab in this room to leave. False when one did not. */
  leaveOtherTabs: () => Promise<boolean>
  /** Is another tab in this room? Asked before anything is deleted. */
  otherTabsAnswer: () => Promise<boolean>
  leaveHere: () => Promise<void>
  clearLocal: () => void
  progress?: (report: TidyStepReport) => void
}

const QUERY_LIMIT = 1000
const IDS_PER_REQUEST = 300

export function tidyUpSteps(opts: { creator: boolean; account: boolean; deleteTombstone: boolean; end?: boolean }): TidyStep[] {
  const steps: TidyStep[] = []
  if (opts.end) steps.push({ id: 'end', label: 'End the room for everyone and retire its link' })
  if (opts.creator) {
    steps.push({ id: 'invitations', label: 'Delete the room’s group invitations, signed with its link keys' })
    steps.push({ id: 'retirement', label: 'Delete the link’s retirement notice, only if no relay still holds an invitation' })
  }
  steps.push({ id: 'tabs', label: 'Leave the room in every tab of this browser' })
  steps.push({ id: 'device', label: 'Delete this device’s chat, files and roster entries for the room' })
  if (opts.account) {
    steps.push({ id: 'bookmark', label: 'Forget the room on your Nostr account with a signed tombstone' })
    steps.push({ id: 'account', label: opts.deleteTombstone
      ? 'Delete your read position for the room, and the tombstone'
      : 'Delete your read position for the room' })
  }
  steps.push({ id: 'local', label: 'Clear every key and cache for the room in this browser' })
  steps.push({ id: 'check', label: 'Ask the relays again and show what is left' })
  return steps
}

/** One NIP-09 request. Addressable records are named by `e` and `a`. */
export function deletionTemplate(events: readonly Event[], now: number, addresses: readonly string[] = []): EventTemplate {
  const kinds = [...new Set(events.map(event => event.kind))].sort((a, b) => a - b)
  return {
    kind: 5,
    created_at: now,
    content: 'Left this KithMoot room and tidied up.',
    tags: [
      ...events.map(event => ['e', event.id]),
      ...addresses.map(address => ['a', address]),
      ...kinds.map(kind => ['k', String(kind)]),
    ],
  }
}

interface Gathered { events: Event[]; unread: string[]; perRelay: Map<string, number> }

async function gather(deps: TidyUpDeps, relays: readonly string[], filter: Filter): Promise<Gathered> {
  const byId = new Map<string, Event>()
  const unread: string[] = []
  const perRelay = new Map<string, number>()
  await Promise.all(relays.map(async relay => {
    let result: HistoryReadResult
    try { result = await deps.read(relay, { ...filter, limit: QUERY_LIMIT }) }
    catch { unread.push(relay); return }
    if (result.terminal !== 'complete') unread.push(relay)
    let count = 0
    for (const event of result.events) {
      // A deletion is not deleted: the request is the record that it was asked.
      if (event.kind === 5) continue
      count++
      byId.set(event.id, event)
    }
    perRelay.set(relay, count)
  }))
  return { events: [...byId.values()].sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1)), unread: unread.sort(), perRelay }
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/** Merge several requests' answers into one per relay: the worst answer wins. */
function worst(answers: PublicDeletionRelayOutcome[][]): PublicDeletionRelayOutcome[] {
  const rank = { accepted: 0, unknown: 1, 'timed-out': 2, refused: 3 } as const
  const byRelay = new Map<string, PublicDeletionRelayOutcome>()
  for (const outcome of answers.flat()) {
    const held = byRelay.get(outcome.relay)
    if (!held || rank[outcome.status] > rank[held.status]) byRelay.set(outcome.relay, outcome)
  }
  return [...byRelay.values()].sort((a, b) => a.relay < b.relay ? -1 : 1)
}

async function requestDeletion(
  deps: TidyUpDeps,
  relays: readonly string[],
  events: readonly Event[],
  sign: (template: EventTemplate) => Promise<Event>,
  addresses: readonly string[] = [],
): Promise<PublicDeletionRelayOutcome[]> {
  if (events.length === 0 && addresses.length === 0) return []
  const groups = events.length ? chunks(events, IDS_PER_REQUEST) : [[]]
  const answers: PublicDeletionRelayOutcome[][] = []
  for (const [index, group] of groups.entries()) {
    // Addresses ride on the first request only; they name every version.
    const event = await sign(deletionTemplate(group, deps.now(), index === 0 ? addresses : []))
    answers.push(await deps.publish(relays, event))
  }
  return worst(answers)
}

const secretSigner = (sk: Uint8Array) => async (template: EventTemplate) => finalizeEvent(template, sk)

export async function runTidyUp(deps: TidyUpDeps): Promise<TidyUpReport> {
  const steps: TidyStepReport[] = []
  const labels = new Map(tidyUpSteps({ creator: !!deps.inviter, account: !!deps.account, deleteTombstone: !!deps.account?.deleteTombstone, end: !!deps.endRoom }).map(step => [step.id, step.label]))
  const record = (report: Omit<TidyStepReport, 'label'>) => {
    const full = { ...report, label: labels.get(report.id) ?? report.id }
    steps.push(full)
    deps.progress?.(full)
    return full
  }

  // Refuse before anything irreversible if a tab in the room cannot be
  // reached: it would go on publishing under the device key being tidied.
  if (!await deps.otherTabsAnswer()) {
    return { steps, remaining: [], refused: 'Another tab in this browser has the room open and did not answer. Leave the room there or close that tab, then try again.' }
  }

  if (deps.endRoom) {
    await deps.endRoom()
    record({ id: 'end', found: 0, answers: [], unread: [] })
  }

  const devicePub = getPublicKey(deps.device.sk)
  const inviterPub = deps.inviter ? getPublicKey(deps.inviter.sk) : undefined

  if (deps.inviter) {
    const filter: Filter = { kinds: [KINDS.GROUP_INVITATION], authors: [inviterPub!], '#d': [deps.inviter.invitationId] }
    const found = await gather(deps, deps.roomRelays, filter)
    const answers = await requestDeletion(deps, deps.roomRelays, found.events, secretSigner(deps.inviter.sk))
    record({ id: 'invitations', found: found.events.length, answers, unread: found.unread })

    const retirements = await gather(deps, deps.roomRelays, { kinds: [KINDS.INVITATION_RETIREMENT], authors: [inviterPub!], '#d': [deps.inviter.invitationId] })
    const after = await gather(deps, deps.roomRelays, filter)
    const clear = found.unread.length === 0 && after.unread.length === 0 && after.events.length === 0
      && answers.every(answer => answer.status === 'accepted')
    if (retirements.events.length === 0) record({ id: 'retirement', found: 0, answers: [], unread: retirements.unread })
    else if (!clear) {
      record({ id: 'retirement', found: retirements.events.length, answers: [], unread: retirements.unread,
        skipped: 'Kept: a relay may still hold the group invitation, and without the notice the old link would open the room again.' })
    } else {
      record({ id: 'retirement', found: retirements.events.length, unread: retirements.unread,
        answers: await requestDeletion(deps, deps.roomRelays, retirements.events, secretSigner(deps.inviter.sk)) })
    }
  }

  const left = await deps.leaveOtherTabs()
  await deps.leaveHere()
  record({ id: 'tabs', found: 0, answers: [], unread: [], ...(left ? {} : { skipped: 'A tab did not confirm it left. Close any other tab with this room open.' }) })

  const device = await gather(deps, deps.roomRelays, { authors: [devicePub] })
  record({ id: 'device', found: device.events.length, unread: device.unread,
    answers: await requestDeletion(deps, deps.roomRelays, device.events, secretSigner(deps.device.sk)) })

  let tombstoneD: string | undefined
  if (deps.account) {
    tombstoneD = await deps.account.forgetBookmark()
    record({ id: 'bookmark', found: tombstoneD ? 1 : 0, answers: [], unread: [],
      ...(tombstoneD ? {} : { skipped: 'No relay confirmed the tombstone yet. Your other devices may still list the room until one does.' }) })

    const account = deps.account
    const ds = [account.readPositionD, account.deleteTombstone ? tombstoneD : undefined].filter((d): d is string => !!d)
    if (ds.length === 0) record({ id: 'account', found: 0, answers: [], unread: [], skipped: 'Nothing of your account’s for this room was known to this browser.' })
    else {
      const found = await gather(deps, deps.accountRelays, { kinds: [30078], authors: [account.pubkey], '#d': ds })
      const addresses = ds.map(d => `30078:${account.pubkey}:${d}`)
      record({ id: 'account', found: found.events.length, unread: found.unread,
        answers: await requestDeletion(deps, deps.accountRelays, found.events, account.sign, addresses) })
    }
  }

  deps.clearLocal()
  record({ id: 'local', found: 0, answers: [], unread: [] })

  const remaining: TidyRemaining[] = []
  const tally = (what: string, found: Gathered) => {
    for (const [relay, count] of found.perRelay) if (count > 0) remaining.push({ what, relay, count })
    for (const relay of found.unread) remaining.push({ what: `${what} (this relay did not answer)`, relay, count: -1 })
  }
  tally('This device’s events', await gather(deps, deps.roomRelays, { authors: [devicePub] }))
  if (inviterPub) tally('Link-key records', await gather(deps, deps.roomRelays, { authors: [inviterPub], '#d': [deps.inviter!.invitationId] }))
  if (deps.account) {
    const ds = [deps.account.readPositionD, deps.account.deleteTombstone ? tombstoneD : undefined].filter((d): d is string => !!d)
    if (ds.length) tally('Your account’s records', await gather(deps, deps.accountRelays, { kinds: [30078], authors: [deps.account.pubkey], '#d': ds }))
  }
  record({ id: 'check', found: remaining.filter(r => r.count > 0).reduce((sum, r) => sum + r.count, 0), answers: [], unread: [] })
  return { steps, remaining: remaining.sort((a, b) => a.what < b.what ? -1 : a.what > b.what ? 1 : a.relay < b.relay ? -1 : 1) }
}
