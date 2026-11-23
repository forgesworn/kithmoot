import test from 'node:test'
import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createBrowserMetadataWindow, createPublicControlTracker, createGeneralObservationStore } from './mixed-invitation-metadata-window.mjs'
import { frameSummary, sha256 } from './mixed-invitation-metadata-audit.mjs'

async function vennelAdapters(root) {
  assert.ok(root.trim(), 'MIXED_INVITATION_VENNEL_ROOT must name a Vennel checkout')
  const lab = resolve(root, 'lab')
  const modules = await Promise.all(['metadata-observation', 'metadata-capture', 'metadata-spool']
    .map(name => import(pathToFileURL(join(lab, `${name}.mjs`)).href)))
  return Object.assign({}, ...modules)
}

// These doubles exercise the browser's adapter calls and lifecycle without a second checkout.
// An explicit Vennel checkout runs the same assertions against the actual recorder and spool.
function testAdapters() {
  const spools = new Map()
  function createMetadataSpool({ directory }) {
    const records = []
    spools.set(directory, records)
    let complete = false
    return {
      append(encoded) { assert.equal(complete, false); records.push(encoded) },
      close() { complete = true },
      snapshot() { return { complete, overflow: false } },
    }
  }
  return {
    TERM_ROLES: Object.keys(terms),
    fixedTermManifest({ terms }) {
      return { roleHashes: Object.fromEntries(Object.entries(terms).map(([role, value]) => [role, sha256(value)])) }
    },
    metadataObservation({ manifest, clock, spoolDirectory }) {
      const records = [], positiveControls = {}
      const spool = spoolDirectory && createMetadataSpool({ directory: spoolDirectory })
      let started, elapsedMs, rawFrameCount = 0
      return {
        start() { started = clock() },
        finish() { elapsedMs = clock() - started; spool?.close() },
        record(record) {
          if (spool) spool.append(JSON.stringify(record))
          else records.push(record)
          rawFrameCount++
        },
        positiveControl(actor, phase, result) {
          positiveControls[`${actor}:${phase}`] = { ...result, elapsedMs: clock() - started }
        },
        snapshot() {
          return { manifest, records, elapsedMs, rawFrameCount, positiveControls, overflow: false,
            ...(spool && { spool: { directory: spoolDirectory, ...spool.snapshot() } }) }
        },
      }
    },
    metadataCaptureHooks({ actor, observation, origins }) {
      return {
        webSocket(wire, direction, source, url) {
          assert.equal(url, origins.signerOrigin)
          assert.ok(['outgoing', 'incoming'].includes(direction))
          assert.equal(source, 'production-app-page')
          observation.record({ actor, capturedValueBytes: Buffer.byteLength(wire) })
        },
      }
    },
    createMetadataSpool,
    materialiseMetadataSnapshot(snapshot) {
      assert.equal(snapshot.spool.complete, true)
      return { ...snapshot, records: spools.get(snapshot.spool.directory).map(value => JSON.parse(value)) }
    },
  }
}

const terms = {
  aliceRootHex: 'a'.repeat(64), aliceRootNpub: `npub1${'q'.repeat(58)}`,
  bobRootHex: 'b'.repeat(64), bobRootNpub: `npub1${'p'.repeat(58)}`,
  aliceDevice: 'c'.repeat(64), bobDevice: 'd'.repeat(64),
  aliceRzTarget: 'e'.repeat(64), bobRzTarget: 'f'.repeat(64),
  pNode: 'p-node', wNode: 'w-node', ordinaryRoomId: 'ordinary-room', mlsSessionId: 'mls-session',
  inviteContext: 'invite-context', messageAlice: 'alice-message', messageBob: 'bob-message',
}
const vennelRoot = process.env.MIXED_INVITATION_VENNEL_ROOT
const adapters = vennelRoot === undefined ? testAdapters() : await vennelAdapters(vennelRoot)
const { fixedTermManifest, metadataObservation, metadataCaptureHooks, TERM_ROLES,
  createMetadataSpool, materialiseMetadataSnapshot } = adapters
const backend = vennelRoot === undefined ? 'test recorder' : 'Vennel recorder'
const signerOrigin = 'wss://link-lab.forgesworn.dev:28444'
const manifest = fixedTermManifest({ terms, salt: Buffer.alloc(32, 7), actionSequence: ['control'], durationMs: 1000, signerOrigin })
const origins = { signerOrigin, ordinaryRelayOrigins: [], appOrigins: ['http://localhost:28445'], nativeRouteOrigins: [], otherOrigins: [] }
const setup = () => {
  let time = 1_000
  const window = createBrowserMetadataWindow({ metadataObservation, metadataCaptureHooks, manifest, origins, clock: () => time })
  window.start()
  return { window, tick: value => { time += value } }
}

test(`browser window forwards records and controls to the ${backend} and completes the boundary`, () => {
  const { window, tick } = setup()
  for (const phase of ['start', 'end']) {
    if (phase === 'end') tick(400)
    for (const [frame, direction] of [['REQ', 'outgoing'], ['EOSE', 'incoming'], ['CLOSE', 'outgoing']]) {
      const wire = frame === 'REQ' ? '["REQ","control",{"kinds":[1],"limit":1}]' : `["${frame}","control"]`
      window.webSocket(wire, direction, 'production-app-page', signerOrigin)
      tick(100)
    }
    window.positiveControl(phase, { req: true, eose: true, close: true })
  }
  const snapshot = window.finish()
  assert.equal(snapshot.records.length, 6)
  assert.equal(snapshot.records.every(record => record.actor === 'alice'), true)
  assert.deepEqual(snapshot.positiveControls, {
    'alice:start': { req: true, eose: true, close: true, elapsedMs: 300 },
    'alice:end': { req: true, eose: true, close: true, elapsedMs: 1000 },
  })
  assert.equal(snapshot.captureBoundaryComplete, true)
  assert.equal(snapshot.coverageGaps, 0)
  assert.equal(snapshot.elapsedMs, 1000)
  assert.deepEqual(Object.keys(snapshot.manifest.roleHashes).sort(), [...TERM_ROLES].sort())
  assert.equal(JSON.stringify(snapshot).includes('["REQ"'), false)
})

test('late callbacks turn the returned boundary incomplete without exporting values', () => {
  const { window } = setup()
  const snapshot = window.finish()
  window.webSocket('late-private-value', 'out', 'production-app-page', signerOrigin)
  assert.equal(snapshot.coverageGaps, 1)
  assert.equal(snapshot.captureBoundaryComplete, false)
  assert.equal(JSON.stringify(snapshot).includes('late-private-value'), false)
  assert.throws(() => window.finish(), /already closed/)
})

test('exact public controls survive a saturated general observation array', () => {
  const id = 'metadata-control-capacity', origin = 'wss://public.example'
  const tracker = createPublicControlTracker({ subscription: id, origin })
  const endpoint = { originSha256: sha256(origin) }
  const observations = Array.from({ length: 10000 }, () => ({ type: 'EVENT' }))
  let observerOverflow = true
  const frame = (wire, source = 'app-websocket', target = endpoint) => {
    const summary = frameSummary(wire, id)
    tracker.frame(source, target, summary)
    if (observations.length < 10000) observations.push(summary)
    else observerOverflow = true
  }
  frame(JSON.stringify(['REQ', 'other', { kinds: [1], limit: 1 }]))
  frame(JSON.stringify(['REQ', id, { kinds: [1], limit: 1 }]), 'bark-worker')
  frame(JSON.stringify(['REQ', id, { kinds: [1], limit: 1 }]), 'app-websocket', { originSha256: sha256('wss://other.example') })
  assert.deepEqual(tracker.snapshot(), { req: false, close: false })
  frame(JSON.stringify(['REQ', id, { kinds: [1], limit: 1 }]))
  frame(JSON.stringify(['CLOSE', id]))
  assert.deepEqual(tracker.snapshot(), { req: true, close: true })
  assert.equal(observations.length, 10000)
  assert.equal(observerOverflow, true)
  assert.equal(JSON.stringify(tracker.snapshot()).includes(id), false)
})

test(`browser window reads back more than 10000 records from the ${backend}`, async t => {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const parent = mkdtempSync(join(tmpdir(), 'kithmoot-browser-metadata-'))
  t.after(() => rmSync(parent, { recursive: true, force: true }))
  const spoolDirectory = join(parent, 'records')
  const window = createBrowserMetadataWindow({ metadataObservation, metadataCaptureHooks, manifest, origins,
    clock: () => 1_000, spoolDirectory })
  window.start()
  for (let index = 0; index < 10_050; index++) {
    window.webSocket(`["NOTICE","record-${index}"]`, 'outgoing', 'production-app-page', signerOrigin)
  }
  const snapshot = window.finish()
  assert.equal(snapshot.rawFrameCount, 10_050)
  assert.equal(snapshot.records.length, 0)
  assert.equal(snapshot.overflow, false)
  assert.equal(snapshot.spool.complete, true)
  const restored = await materialiseMetadataSnapshot(snapshot)
  assert.equal(restored.records.length, 10_050)
  assert.equal(restored.records.at(-1).capturedValueBytes, Buffer.byteLength('["NOTICE","record-10049"]'))
  assert.equal(JSON.stringify(restored).includes('record-10049'), false)
})

test(`general browser audit forwards every record to the ${backend} and preserves its digest and aggregates`, async t => {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const parent = mkdtempSync(join(tmpdir(), 'kithmoot-general-observation-'))
  t.after(() => rmSync(parent, { recursive: true, force: true }))
  const store = createGeneralObservationStore({ directory: join(parent, 'records'), createMetadataSpool })
  const records = Array.from({ length: 10_050 }, (_, index) => ({ source: 'app-websocket', originAlias: 'public-relay',
    originSha256: 'a'.repeat(64), pathSha256: 'b'.repeat(64), length: 2, index }))
  for (const value of records) store.append(value)
  const snapshot = store.close()
  assert.equal(snapshot.observationCount, 10_050)
  assert.equal(snapshot.observerOverflow, false)
  assert.equal(snapshot.observationSpool.complete, true)
  assert.equal(snapshot.observationDigest, sha256(JSON.stringify(records)))
  assert.deepEqual(snapshot.sourceCounts, { 'app-websocket': 10_050 })
  assert.deepEqual(Object.values(snapshot.endpoints), [{ items: 10_050, bytes: 20_100 }])
  const restored = await materialiseMetadataSnapshot({ records: [], rawFrameCount: snapshot.observationCount,
    spool: snapshot.observationSpool })
  assert.deepEqual(restored.records, records)
  store.append(records[0])
  const afterClose = store.snapshot()
  assert.equal(afterClose.observationCount, snapshot.observationCount)
  assert.equal(afterClose.observationDigest, snapshot.observationDigest)
  assert.equal(afterClose.observationSpool.complete, true)
  assert.equal(afterClose.observerOverflow, true)
})
