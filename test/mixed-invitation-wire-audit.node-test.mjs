import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { wireMatches } from './mixed-invitation-wire-audit.mjs'
const identifier = createHash('sha256').update('synthetic-metadata-audit-control').digest()

test('detects literal binary identifiers and their textual encodings', () => {
  const wire = Buffer.concat([Buffer.from([0xff, 0x00, 0x80]), identifier, Buffer.from([0xfe])])
  assert.equal(wireMatches(wire, identifier.toString('hex')), true)
  assert.equal(wireMatches(wire, identifier.toString('base64url')), true)
  assert.equal(wireMatches(Buffer.from(JSON.stringify({ handle: identifier.toString('hex') })), identifier.toString('hex')), true)
})
test('does not report an identifier absent from the observed bytes', () => {
  const other = createHash('sha256').update('independent-observer-alive-control').digest()
  assert.equal(wireMatches(other, identifier.toString('hex')), false)
  assert.equal(wireMatches(other, identifier.toString('base64url')), false)
  assert.equal(wireMatches(Buffer.from([0xff, 0x00]), ''), false)
})
