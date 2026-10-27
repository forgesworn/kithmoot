import test from 'node:test'
import assert from 'node:assert/strict'
import {
  AttachmentStream, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_CHUNK_BYTES, MAX_ATTACHMENT_CHUNKS,
  normaliseAttachmentChunk, parseAttachmentRange, validateAttachmentMetadata,
} from '../attachment-stream.mjs'

const image = (overrides = {}) => ({ name: 'picture.png', type: 'image/png', kind: 'image', size: 8, ...overrides })

test('metadata admits only bounded media with a MIME matching its kind', () => {
  assert.deepEqual(validateAttachmentMetadata(image()), image())
  assert.deepEqual(validateAttachmentMetadata(image({ name: 'sound.ogg', type: 'audio/ogg', kind: 'audio' })), image({ name: 'sound.ogg', type: 'audio/ogg', kind: 'audio' }))
  assert.deepEqual(validateAttachmentMetadata(image({ name: 'film.mp4', type: 'video/mp4', kind: 'video' })), image({ name: 'film.mp4', type: 'video/mp4', kind: 'video' }))
  assert.deepEqual(validateAttachmentMetadata(image({ name: 'vector.svg', type: 'image/svg+xml' })), image({ name: 'vector.svg', type: 'image/svg+xml' }))
  for (const metadata of [
    undefined, null, [], image({ name: '' }), image({ name: 'x'.repeat(256) }), image({ name: 'bad\nname' }),
    image({ type: 'application/pdf' }), image({ type: 'image/png', kind: 'video' }),
    image({ type: 'IMAGE/PNG' }), image({ kind: 'file' }), image({ kind: '__proto__' }), image({ kind: 'constructor' }), image({ size: 0 }), image({ size: -1 }),
    image({ size: 1.5 }), image({ size: MAX_ATTACHMENT_BYTES + 1 }), image({ size: Number.MAX_SAFE_INTEGER + 1 }),
  ]) assert.equal(validateAttachmentMetadata(metadata), undefined)
})

test('chunks are copied Uint8Array or ArrayBuffer bytes with a hard bound', () => {
  const source = new Uint8Array([1, 2, 3])
  const copied = normaliseAttachmentChunk(source)
  source[0] = 9
  assert.deepEqual([...copied], [1, 2, 3])
  assert.deepEqual([...normaliseAttachmentChunk(new Uint8Array([4, 5]).buffer)], [4, 5])
  assert.deepEqual([...normaliseAttachmentChunk(Buffer.from([6]))], [6])
  assert.equal(normaliseAttachmentChunk(new DataView(new ArrayBuffer(2))), undefined)
  assert.equal(normaliseAttachmentChunk(new Uint16Array(2)), undefined)
  assert.equal(normaliseAttachmentChunk(new Uint8Array(MAX_ATTACHMENT_CHUNK_BYTES + 1)), undefined)
  assert.equal(normaliseAttachmentChunk('bytes'), undefined)
})

test('a stream accepts ordered bounded chunks and exposes ranges without concatenating it', async () => {
  const stream = new AttachmentStream('id', image())
  const waiting = stream.ready()
  assert.equal(stream.write(new Uint8Array([0, 1, 2]), false), true)
  assert.equal(stream.received, 3)
  assert.equal(stream.complete, false)
  assert.equal(await Promise.race([waiting.then(() => 'settled'), Promise.resolve('pending')]), 'pending')
  assert.equal(stream.write(new Uint8Array([3, 4, 5, 6, 7]).buffer, true), true)
  assert.equal(await waiting, true)
  assert.equal(stream.complete, true)
  const parts = stream.range(2, 6)
  assert.equal(parts.length, 2)
  assert.deepEqual(parts.map(part => [...part]), [[2], [3, 4, 5, 6]])
  assert.deepEqual([...stream.range(0, 7)[0]], [0, 1, 2])
  assert.equal(stream.range(-1, 2), undefined)
  assert.equal(stream.range(0, 8), undefined)
  assert.equal(stream.write(new Uint8Array(), true), false)
})

test('invalid writes and premature finish invalidate pending consumers', async () => {
  for (const run of [
    stream => stream.write(new Uint8Array(), false),
    stream => stream.write(new Uint8Array(9), false),
    stream => stream.write(new Uint8Array([1]), true),
    stream => stream.write(new DataView(new ArrayBuffer(1)), false),
    stream => stream.write(new Uint8Array([1]), 'yes'),
  ]) {
    const stream = new AttachmentStream('id', image())
    const waiting = stream.ready()
    assert.equal(run(stream), false)
    assert.equal(stream.active, false)
    assert.equal(await waiting, false)
    assert.equal(stream.range(0, 0), undefined)
  }
})

test('tiny chunks cannot create unbounded stream bookkeeping', () => {
  const stream = new AttachmentStream('id', image({ size: MAX_ATTACHMENT_CHUNKS + 1 }))
  for (let index = 0; index < MAX_ATTACHMENT_CHUNKS; index++) assert.equal(stream.write(new Uint8Array([1]), false), true)
  assert.equal(stream.write(new Uint8Array([1]), false), false)
  assert.equal(stream.active, false)
})

test('final empty chunk can finish an exactly filled stream', async () => {
  const stream = new AttachmentStream('id', image({ size: 2 }))
  assert.equal(stream.write(new Uint8Array([7, 8]), false), true)
  assert.equal(stream.write(new Uint8Array(), true), true)
  assert.equal(await stream.ready(), true)
})

test('single byte ranges cover open, bounded and suffix forms', () => {
  assert.deepEqual(parseAttachmentRange(undefined, 10), { start: 0, end: 9 })
  assert.deepEqual(parseAttachmentRange('bytes=2-4', 10), { start: 2, end: 4 })
  assert.deepEqual(parseAttachmentRange('bytes=7-', 10), { start: 7, end: 9 })
  assert.deepEqual(parseAttachmentRange('bytes=7-99', 10), { start: 7, end: 9 })
  assert.deepEqual(parseAttachmentRange('bytes=-3', 10), { start: 7, end: 9 })
  assert.deepEqual(parseAttachmentRange('bytes=-30', 10), { start: 0, end: 9 })
  assert.deepEqual(parseAttachmentRange('bytes=0-0', 1), { start: 0, end: 0 })
  for (const header of ['', 'items=0-1', 'bytes=', 'bytes=-0', 'bytes=4-2', 'bytes=10-', 'bytes=0-1,3-4', 'bytes=a-b', 'bytes=0 - 1']) {
    assert.equal(parseAttachmentRange(header, 10), null, header)
  }
  assert.equal(parseAttachmentRange(undefined, 0), null)
})
