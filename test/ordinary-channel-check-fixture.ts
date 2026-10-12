import { channelCheckHash } from '@forgesworn/signet-contacts'
import { ChannelChecks } from '../app/src/channel-checks.js'
import { memoryDeviceStore } from '../app/src/device-store.js'

export const CHANNEL_CHECK_MODES = ['empty', 'requested-unsent', 'requested-sent', 'incoming', 'declined', 'accepted-unsent',
  'accepted-sent', 'reveal-pending', 'reveal-retry-unsent', 'complete-requester', 'complete-recipient',
  'complete-retry-unsent', 'recipient-retry-unsent', 'confirmed', 'both'] as const
export type ChannelCheckMode = typeof CHANNEL_CHECK_MODES[number]
export async function channelCheckFixture(mode: ChannelCheckMode = 'both') {
  const local = '1'.repeat(64), peer = '2'.repeat(64), context = '3'.repeat(64), store = memoryDeviceStore()
  const snapshots: { key: string; raw: string }[] = [], toLocal: string[] = [], toPeer: string[] = []
  const set = store.set.bind(store)
  store.set = (key, raw) => { set(key, raw); snapshots.push({ key, raw }) }
  let fail = false
  const make = (participant: string) => new ChannelChecks({ local: participant, context, store, current: () => true,
    now: () => 1700000000, lock: async task => task(), send: async text => {
      if (fail) throw new Error('fixture offline')
      ;(participant === local ? toPeer : toLocal).push(text)
    } })
  const requester = make(local), recipient = make(peer)
  const records = new Map<string, string>()
  if (mode === 'empty') return { records, local, peer, context }
  const id = await requester.start(peer)
  await recipient.receive(local, toPeer.shift()!)
  if (mode === 'declined') await recipient.decline(id)
  else {
    await recipient.accept(id)
    if (mode === 'reveal-retry-unsent') fail = true
    try { await requester.receive(peer, toLocal.shift()!) } catch (error) { if (!fail) throw error }
    if (mode === 'reveal-retry-unsent') { try { await requester.retry(id) } catch { /* Retained real pre-send cut. */ } }
    else {
      await recipient.receive(local, toPeer.shift()!)
      if (mode === 'complete-retry-unsent') await requester.retry(id)
      if (mode === 'recipient-retry-unsent') await recipient.retry(id)
      if (mode === 'confirmed' || mode === 'both') { await requester.confirm(id); await recipient.confirm(id) }
    }
  }
  if (mode === 'both') for (const key of store.keys()) records.set(key, store.get(key)!)
  else {
    const chosen = snapshots.find(({ key, raw }) => {
      const row = JSON.parse(raw)[0], state = row.state, requesterKey = key.includes(`.${local}.`)
      switch (mode) {
        case 'requested-unsent': return requesterKey && state?.phase === 'requested' && !row.sent
        case 'requested-sent': return requesterKey && state?.phase === 'requested' && !!row.sent
        case 'incoming': return !requesterKey && !state && !row.declined
        case 'declined': return row.declined === true
        case 'accepted-unsent': return state?.phase === 'accepted' && !row.sent
        case 'accepted-sent': return state?.phase === 'accepted' && !!row.sent
        case 'reveal-pending': return state?.phase === 'reveal-pending' && !!row.sent
        case 'reveal-retry-unsent': return state?.phase === 'reveal-pending' && !row.sent
        case 'complete-requester': return requesterKey && state?.phase === 'complete' && !!row.sent
        case 'complete-recipient': return !requesterKey && state?.phase === 'complete' && !!row.sent
        case 'complete-retry-unsent': return requesterKey && state?.phase === 'complete' && !row.sent
        case 'recipient-retry-unsent': return !requesterKey && state?.phase === 'complete' && !row.sent
        case 'confirmed': return requesterKey && row.checkedAt !== undefined
      }
    })
    if (!chosen) throw new Error('Missing actual channel-check write cut: ' + mode)
    records.set(chosen.key, chosen.raw)
  }
  return { records, local, peer, context }
}

export const CHANNEL_CHECK_FAULTS = ['version', 'local', 'context', 'suffix', 'wrapped', 'nested-wrapped', 'bare',
  'json', 'whitespace', 'duplicate-json', 'shape', 'empty-history', 'row-count', 'raw-size', 'duplicate-id', 'row-extra', 'state-extra',
  'request-extra', 'acceptance-extra', 'reveal-extra', 'request-version', 'request-id', 'request-peer', 'request-ttl',
  'request-time', 'request-commitment', 'saved-request', 'role', 'phase', 'nonce', 'acceptance-nonce',
  'acceptance-time', 'acceptance-hash', 'reveal-nonce', 'reveal-time', 'reveal-hash', 'missing-reveal', 'declined-state',
  'declined-false', 'sent', 'sent-peer-message', 'sent-prior-message', 'checked-time', 'checked-shape', 'null-state'] as const
export type ChannelCheckFault = typeof CHANNEL_CHECK_FAULTS[number]
export function damageChannelCheckFixture(fixture: Awaited<ReturnType<typeof channelCheckFixture>>, records: Map<string, string>, fault: ChannelCheckFault) {
  const key = `kithmoot.channel-checks.v1.${fixture.local}.${fixture.context}`, raw = records.get(key)!
  const rows = JSON.parse(raw), row = rows[0], saved = row.state
  const move = (name: string) => { records.delete(key); records.set(name, raw) }
  if (fault === 'version') return move(key.replace('.v1.', '.v2.'))
  if (fault === 'local') return move(key.replace(fixture.local, '4'.repeat(64)))
  if (fault === 'context') return move(key.replace(fixture.context, '4'.repeat(64)))
  if (fault === 'suffix') return move(key + '.extra')
  if (fault === 'wrapped') return move(`kithmoot.account.${fixture.peer}.${key}`)
  if (fault === 'nested-wrapped') return move(`kithmoot.account.${fixture.peer}.kithmoot.account.${fixture.local}.${key}`)
  if (fault === 'bare') return move('kithmoot.channel-checks')
  if (fault === 'json') return records.set(key, '{broken')
  if (fault === 'whitespace') return records.set(key, ' ' + raw)
  if (fault === 'duplicate-json') return records.set(key, raw.replace('"checkedAt":1700000000', '"checkedAt":0,"checkedAt":1700000000'))
  if (fault === 'shape') return records.set(key, '{}')
  if (fault === 'empty-history') return records.set(key, '[]')
  if (fault === 'row-count') return records.set(key, JSON.stringify(Array(257).fill(row)))
  if (fault === 'raw-size') return records.set(key, ' '.repeat(1024 * 1024 + 1))
  if (fault === 'duplicate-id') rows.push(row)
  if (fault === 'row-extra') row.private = 'unknown'
  if (fault === 'state-extra') saved.private = 'unknown'
  if (fault === 'request-extra') row.request.private = 'unknown'
  if (fault === 'acceptance-extra') saved.acceptance.private = 'unknown'
  if (fault === 'reveal-extra') saved.reveal.private = 'unknown'
  if (fault === 'request-version') row.request.v = 2
  if (fault === 'request-id') row.request.id = 'f'.repeat(31)
  if (fault === 'request-peer') row.request.to = row.request.from
  if (fault === 'request-ttl') row.request.expiresAt = row.request.createdAt + 601
  if (fault === 'request-time') row.request.createdAt = -1
  if (fault === 'request-commitment') row.request.commitment = 'f'.repeat(64)
  if (fault === 'saved-request') saved.request.context = 'f'.repeat(64)
  if (fault === 'role') saved.role = 'recipient'
  if (fault === 'phase') saved.phase = 'reveal-pending'
  if (fault === 'nonce') saved.nonce = 'g'.repeat(64)
  if (fault === 'acceptance-nonce') saved.acceptance.nonce = 'f'.repeat(64)
  if (fault === 'acceptance-time') saved.acceptance.createdAt = row.request.createdAt - 1
  if (fault === 'acceptance-hash') saved.acceptance.requestHash = 'f'.repeat(64)
  if (fault === 'reveal-nonce') saved.reveal.nonce = 'f'.repeat(64)
  if (fault === 'reveal-time') saved.reveal.createdAt = row.request.expiresAt
  if (fault === 'reveal-hash') saved.reveal.acceptanceHash = 'f'.repeat(64)
  if (fault === 'missing-reveal') delete saved.reveal
  if (fault === 'declined-state') row.declined = true
  if (fault === 'declined-false') row.declined = false
  if (fault === 'sent') row.sent = 'f'.repeat(64)
  if (fault === 'sent-peer-message') row.sent = JSON.parse(records.get(`kithmoot.channel-checks.v1.${fixture.peer}.${fixture.context}`)!)[0].sent
  if (fault === 'sent-prior-message') { // A genuine hash from an impossible complete/request-sent combination.
    row.sent = channelCheckHash(row.request)
  }
  if (fault === 'checked-time') row.checkedAt = saved.reveal.createdAt - 1
  if (fault === 'checked-shape') row.checkedAt = '1700000000'
  if (fault === 'null-state') row.state = null
  records.set(key, JSON.stringify(rows))
}
