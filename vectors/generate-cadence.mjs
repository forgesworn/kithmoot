#!/usr/bin/env node
// Generate the shared cadence v1 wire fixture from fixed public test inputs.
// Production signing keeps random BIP-340 auxiliary data; frozen vectors use
// explicit labelled auxiliary data so TypeScript, Kotlin and Rust can compare
// exact bytes.

import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { base64 } from '@scure/base'
import { bytesToHex } from '@noble/hashes/utils'
import {
  buildCadenceLease,
  buildCadenceQueue,
  buildCadenceRekey,
  cadenceLeasePath,
  cadenceQueuePath,
  cadenceRekeyPath,
  cadencePayloadSha256,
} from '../dist/src/box-cadence.js'
import { deriveSecretKey, finalizeDeterministic, seed32 } from './lib/determinism.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const output = join(here, 'cadence-v1.json')
const encoder = new TextEncoder()
const now = 1_800_000_000
const nodeId = 'a'.repeat(52)
const stableRoom = '42'.repeat(32)
const trafficRoom = '43'.repeat(32)
const personaSecret = deriveSecretKey('cadence-persona')
const deviceSecret = deriveSecretKey('cadence-device')
const persona = bytesToHex((await import('@noble/curves/secp256k1.js')).schnorr.getPublicKey(personaSecret))
const device = bytesToHex((await import('@noble/curves/secp256k1.js')).schnorr.getPublicKey(deviceSecret))
const expiry = 500_004 * 3_600

const credential = finalizeDeterministic({
  kind: 20_460,
  created_at: now,
  tags: [['d', stableRoom], ['device', device], ['expiration', String(expiry)]],
  content: '',
}, personaSecret, seed32('cadence-credential-aux'))

const lease = buildCadenceLease({
  nodeId,
  room: stableRoom,
  trafficRoom,
  roomGeneration: 2,
  persona,
  device,
  credential,
  grantId: '33'.repeat(16),
  requestId: '22'.repeat(16),
  leaseId: '11'.repeat(16),
  generation: 1,
  deviceSlot: 0,
  currentEpoch: 500_000,
  startEpoch: 500_002,
  endEpoch: 500_004,
  roomKey: seed32('cadence-successor-room-key'),
  publicRelays: ['wss://relay-a.example', 'wss://relay-b.example'],
  circleBoxes: ['local'],
  now,
})

const inner = finalizeDeterministic({
  kind: 1_460,
  created_at: now,
  tags: [['d', trafficRoom]],
  content: 'encrypted-test-event',
}, deviceSecret, seed32('cadence-inner-aux'))
const queue = buildCadenceQueue(lease, '44'.repeat(16), inner)
const rekey = buildCadenceRekey(lease, '55'.repeat(16), 3)

function wire(name, method, path, value) {
  const body = JSON.stringify(value)
  const payload = cadencePayloadSha256(body)
  const authorizationEvent = finalizeDeterministic({
    kind: 27_235,
    created_at: now,
    tags: [['u', `http://${nodeId}${path}`], ['method', method], ['payload', payload]],
    content: '',
  }, deviceSecret, seed32(`cadence-${name}-authorization-aux`))
  const ordered = {
    id: authorizationEvent.id,
    pubkey: authorizationEvent.pubkey,
    created_at: authorizationEvent.created_at,
    kind: authorizationEvent.kind,
    tags: authorizationEvent.tags,
    content: authorizationEvent.content,
    sig: authorizationEvent.sig,
  }
  return {
    authorization: `Nostr ${base64.encode(encoder.encode(JSON.stringify(ordered)))}`,
    authorization_event: ordered,
    body,
    content_type: 'application/json',
    method,
    path,
    payload_sha256: payload,
  }
}

const vectors = {
  about: 'Frozen cadence v1 Link bodies and NIP-98 events. All keys are public test fixtures and sign nothing outside this file.',
  allowlisted_destinations: ['wss://relay-a.example', 'wss://relay-b.example'],
  generated_by: 'kithmoot vectors/generate-cadence.mjs',
  grant: {
    active: true,
    device,
    expires_at: expiry,
    grant_id: lease.grant_id,
    persona,
    room: stableRoom,
    server: lease.server,
    write_1460: true,
  },
  hostile_single_field_mutations: [
    { name: 'signature', target: 'lease.authorization_event.sig', replacement: '0'.repeat(128), expect: 'authentication' },
    { name: 'server', target: 'lease.body.server', replacement: `ws://${'b'.repeat(52)}/events`, expect: 'scope' },
    { name: 'room', target: 'lease.body.room', replacement: '44'.repeat(32), expect: 'scope' },
    { name: 'traffic_room', target: 'queue.body.traffic_room', replacement: stableRoom, expect: 'scope' },
    { name: 'room_generation', target: 'lease.body.room_generation', replacement: 0, expect: 'id or generation' },
    { name: 'persona', target: 'lease.body.persona', replacement: '0'.repeat(64), expect: 'scope' },
    { name: 'device', target: 'lease.body.device', replacement: '0'.repeat(64), expect: 'scope' },
    { name: 'slot_seconds', target: 'lease.body.slot_seconds', replacement: 301, expect: 'profile' },
    { name: 'counter_lo', target: 'lease.body.counter_lo', replacement: 1, expect: 'counter range' },
    { name: 'counter_hi', target: 'lease.body.counter_hi', replacement: 9, expect: 'counter range' },
    { name: 'generation', target: 'lease.body.generation', replacement: 0, expect: 'id or generation' },
    { name: 'credential_expiration', target: 'lease.body.credential.tags.expiration', replacement: String(expiry - 1), expect: 'credential expires before lease' },
    { name: 'payload_sha256', target: 'lease.authorization_event.tags.payload', replacement: '0'.repeat(64), expect: 'authentication' },
    { name: 'method', target: 'lease.authorization_event.tags.method', replacement: 'POST', expect: 'authentication' },
    { name: 'url', target: 'lease.authorization_event.tags.u', replacement: `http://${nodeId}/cadence/v1/status`, expect: 'authentication' },
    { name: 'request_id_reuse_with_changed_body', target: 'lease.body.bucket_bytes', replacement: 4095, expect: 'request conflict' },
  ],
  lease: wire('lease', 'PUT', cadenceLeasePath(lease.lease_id), lease),
  node_id: nodeId,
  now,
  queue: wire('queue', 'POST', cadenceQueuePath(lease.lease_id), queue),
  rekey: wire('rekey', 'PUT', cadenceRekeyPath(lease.lease_id), rekey),
  version: 1,
}

writeFileSync(output, `${JSON.stringify(vectors, null, 2)}\n`)
