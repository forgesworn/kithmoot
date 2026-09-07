import { bytesToHex } from '@noble/hashes/utils'
import { getPublicKey } from 'nostr-tools/pure'
import { deriveServiceKey, deriveServiceRoom, decodeMemberPass, decodeServicePolicy, normaliseServiceAudience } from '../../dist/src/service-admission.js'
import { deriveSecretKey, finalizeDeterministic, seed32 } from './determinism.mjs'

export function serviceAdmissionVectors() {
  const serviceAudience = [
    ['blossom', 'https://files.example', true],
    ['blossom', 'https://files.example:8443', true],
    ['blossom', 'https://127.0.0.1', true],
    ['blossom', 'https://[::1]', true],
    ['blossom', 'https://[2001:db8::1]:8443', true],
    ['nudger', 'https://notify.example/rooms//a%20b', true],
    ['blossom', 'https://files.example:', false],
    ['blossom', 'https://files.example:08443', false],
    ['blossom', 'https://files.example:443', false],
    ['blossom', 'https://127.1', false],
    ['blossom', 'https://0x7f000001', false],
    ['blossom', 'https://[0:0:0:0:0:0:0:1]', false],
    ['blossom', 'https://files_example', false],
    ['blossom', 'https://Files.example', false],
    ['nudger', 'https://notify.example/a/%2e%2e/b', false],
    ['nudger', 'https://notify.example/rooms?', false],
    ['nudger', 'https://notify.example/rooms#', false],
    ['nudger', 'https://notify.example/%wrong', false],
    ['nudger', 'https://notify.example/a/../b', false],
  ].map(([type, id, accepted]) => ({ name: type + '-' + id, kind: accepted ? 'positive' : 'negative', input: { type, id }, expected: { result: accepted ? { type, id } : null } }))
  for (const v of serviceAudience) if (JSON.stringify(normaliseServiceAudience(v.input)) !== JSON.stringify(v.expected.result)) throw new Error('Audience vector disagreement: ' + v.name)
  const authority = deriveSecretKey('service-authority')
  const device = deriveSecretKey('service-device')
  const secret = seed32('service-traffic')
  const roomId = bytesToHex(seed32('service-room'))
  const now = 1_800_000_000
  const audiences = [
    { type: 'blossom', id: 'https://files.example' },
    { type: 'blossom', id: 'https://other.example' },
    { type: 'turn', id: 'https://turn.example' },
    { type: 'forwarder', id: getPublicKey(deriveSecretKey('service-forwarder')) },
    { type: 'nudger', id: 'https://notify.example/rooms' },
  ]
  const serviceScope = audiences.map(audience => ({ name: audience.type + '-' + audience.id, kind: 'positive',
    input: { authoritySkHex: bytesToHex(authority), deviceSkHex: bytesToHex(device), trafficSecretHex: bytesToHex(secret), roomId, audience },
    output: { authoritySkHex: bytesToHex(deriveServiceKey(authority, roomId, audience, 'authority')),
      deviceSkHex: bytesToHex(deriveServiceKey(device, roomId, audience, 'device')),
      room: deriveServiceRoom(secret, roomId, audience) } }))
  const audience = audiences[0]
  const scoped = deriveServiceKey(authority, roomId, audience, 'authority')
  const pass = { v: 1, audience, room: deriveServiceRoom(secret, roomId, audience), device: getPublicKey(deriveServiceKey(device, roomId, audience, 'device')), epoch: 2, expiresAt: now + 60, permissions: ['upload'] }
  const policy = { v: 1, audience, room: pass.room, enforcementEpoch: 2, activateAt: now + 10, graceEnd: now + 30 }
  function build(kind, value, tags, name) {
    return finalizeDeterministic({ kind, created_at: now, tags, content: JSON.stringify(value) }, scoped, seed32('service-' + name))
  }
  const passTags = [['d', pass.room], ['p', pass.device], ['expiration', String(pass.expiresAt)]]
  const passes = [
    ['valid', pass, passTags, true],
    ['unknown-fields-projected', { ...pass, authority: 'untrusted-extra' }, passTags, true],
    ['wrong-version', { ...pass, v: 2 }, passTags, false],
    ['noncanonical-audience', { ...pass, audience: { ...audience, id: 'https://files.example/' } }, passTags, false],
    ['duplicate-permissions', { ...pass, permissions: ['upload', 'upload'] }, passTags, false],
    ['negative-epoch', { ...pass, epoch: -1 }, passTags, false],
    ['expiry-before-issue', { ...pass, expiresAt: now - 1 }, [['d', pass.room], ['p', pass.device], ['expiration', String(now - 1)]], false],
    ['wrong-device-tag', pass, [['d', pass.room], ['p', getPublicKey(device)], ['expiration', String(pass.expiresAt)]], false],
    ['duplicate-room-tag', pass, [...passTags, ['d', pass.room]], false],
  ]
  const memberPass = passes.map(([name, value, tags, accepted]) => ({ name, kind: accepted ? 'positive' : 'negative',
    input: { event: build(20470, value, tags, name) }, expected: { result: accepted ? pass : null } }))
  memberPass.push({ name: 'integral-json-exponent', kind: 'positive', input: { event: finalizeDeterministic({ kind: 20470, created_at: now, tags: passTags, content: JSON.stringify(pass).replace('"epoch":2', '"epoch":2e0') }, scoped, seed32('service-exponent')) }, expected: { result: pass } })
  const policies = [
    ['valid', policy, [['d', pass.room]], true],
    ['unknown-fields-projected', { ...policy, operatorOverride: true }, [['d', pass.room]], true],
    ['backward-grace', { ...policy, graceEnd: now }, [['d', pass.room]], false],
    ['fractional-epoch', { ...policy, enforcementEpoch: 1.5 }, [['d', pass.room]], false],
    ['wrong-address', policy, [['d', roomId]], false],
    ['duplicate-address', policy, [['d', pass.room], ['d', pass.room]], false],
  ]
  const servicePolicy = policies.map(([name, value, tags, accepted]) => ({ name, kind: accepted ? 'positive' : 'negative',
    input: { event: build(30460, value, tags, 'policy-' + name) }, expected: { result: accepted ? policy : null } }))
  for (const [list, decode] of [[memberPass, decodeMemberPass], [servicePolicy, decodeServicePolicy]]) {
    const invalid = JSON.parse(JSON.stringify(list[0]))
    invalid.name = 'invalid-signature'; invalid.kind = 'negative'; invalid.input.event.sig = '00'.repeat(64); invalid.expected.result = null
    list.push(invalid)
    for (const v of list) if (JSON.stringify(decode(v.input.event)) !== JSON.stringify(v.expected.result)) throw new Error('Service vector disagreement: ' + v.name)
  }
  return { memberPass, servicePolicy, serviceScope, serviceAudience }
}
