import { describe, expect, it } from 'vitest'
import { createRoomInvitation, decodeInvitationDecline, decodeRoomAdmissionGrant, encodeInvitationGrant } from '../../src/invitation.js'
import { getPublicKey } from 'nostr-tools/pure'
import type { RelayTransport } from '../../src/relay-pool.js'
import { prepareInvitationRefusal } from './invitation-refusal.js'

function fixture() {
  const host = createRoomInvitation(), key = new Uint8Array(32).fill(7), request = 'ab'.repeat(32)
  const events: Parameters<RelayTransport['publish']>[0][] = []
  let current = true, clock = 1_800_000_000, fail = false
  let wait: Promise<void> | undefined
  const publish: RelayTransport['publish'] = async event => {
    events.push(event); if (wait) await wait; if (fail) throw new Error('Synthetic relay refusal')
  }
  const transport: RelayTransport = { close: () => {}, subscribe: () => () => {}, publish,
    publishGuarded: async (event, current) => { if (!current()) throw new Error('No longer authorised'); await publish(event) } }
  const opts = { invitation: host.invitation, inviterSk: host.inviterSk, delegation: [],
    requester: getPublicKey(key), request, transport, expiresAt: clock + 90, now: () => clock, stillCurrent: () => current }
  return { host, key, request, opts, events,
    change: () => { current = false }, expire: () => { clock += 90 }, failure: (value: boolean) => { fail = value }, hold: (value: Promise<void>) => { wait = value } }
}

describe('explicit refusal dispatch', () => {
  it('publishes an authenticated refusal carrying no admission capability', async () => {
    const f = fixture(), before = [...f.host.inviterSk]
    const attempt = prepareInvitationRefusal(f.opts); await attempt.send()
    expect(decodeInvitationDecline(f.events[0]!, { invitation: f.host.invitation, requesterSk: f.key, request: f.request, now: f.opts.now() })).not.toBeNull()
    expect(decodeRoomAdmissionGrant(f.events[0]!, { invitation: f.host.invitation, requesterSk: f.key, request: f.request, now: f.opts.now() })).toBeNull()
    expect([...f.host.inviterSk]).toEqual(before)
  })
  it('retry after rejected confirmation sends the identical signed event', async () => {
    const f = fixture(), attempt = prepareInvitationRefusal(f.opts)
    f.failure(true); await expect(attempt.send()).rejects.toThrow('Synthetic')
    f.failure(false); await attempt.send()
    expect(f.events).toHaveLength(2); expect(f.events[0]).toBe(f.events[1])
  })
  it.each(['room/authority changed', 'expired'])('never dispatches after %s', async change => {
    const f = fixture(), attempt = prepareInvitationRefusal(f.opts)
    if (change === 'expired') f.expire(); else f.change()
    await expect(attempt.send()).rejects.toThrow('no longer current')
    expect(f.events).toHaveLength(0)
  })
  it('late acknowledgement cannot report success after the source permission changes', async () => {
    const f = fixture(); let release!: () => void
    f.hold(new Promise<void>(resolve => { release = resolve }))
    const attempt = prepareInvitationRefusal(f.opts), send = attempt.send()
    f.change(); release(); await expect(send).rejects.toThrow('no longer current')
    expect(f.events).toHaveLength(1)
    await expect(attempt.send()).rejects.toThrow('no longer current')
    expect(f.events).toHaveLength(1)
  })
  it('a carrier without write guards cannot receive the refusal', async () => {
    const f = fixture(); delete f.opts.transport.publishGuarded
    await expect(prepareInvitationRefusal(f.opts).send()).rejects.toThrow('cannot safely send')
    expect(f.events).toHaveLength(0)
  })
  it('cannot publish once the signed responder delegation expires even if the UI deadline remains', async () => {
    const f = fixture(), responderKey = new Uint8Array(32).fill(8)
    let time = f.opts.now()
    const grant = encodeInvitationGrant({ invitation: f.host.invitation, inviterSk: f.host.inviterSk,
      requester: getPublicKey(responderKey), request: f.request, roomSecret: new Uint8Array(32).fill(9), now: time })
    const responder = decodeRoomAdmissionGrant(grant, { invitation: f.host.invitation, requesterSk: responderKey, request: f.request, now: time })!.delegate!
    const attempt = prepareInvitationRefusal({ ...f.opts, inviterSk: responder.delegateSk,
      delegation: responder.chain, expiresAt: time + 86_400, now: () => time })
    time = responder.chain[0]!.expiresAt
    await expect(attempt.send()).rejects.toThrow('no longer current')
    expect(f.events).toHaveLength(0)
  })
})
