import { describe, expect, it } from 'vitest'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { hexToBytes } from '@noble/hashes/utils'
import { nip44 } from 'nostr-tools'
import type { Event } from 'nostr-tools/pure'
import { finalizeDeterministic } from './lib/determinism.mjs'
import { decodeRosterEvent } from '../src/roster.js'
import { sanitiseLiveRecordingState, verifyLiveRecordingState } from '../src/live-recording.js'
import { KINDS } from '../src/kinds.js'
import type { RosterEntry } from '../src/types.js'
import type { LiveRecordingState } from '../src/live-recording.js'

interface Row {
  name: string
  input: { entry: RosterEntry; roomId: string; roomKeyHex: string; deviceSkHex: string; nonceHex: string; auxRandHex: string; authority: string; verificationRoom: string }
  event: Event
  expected: { entry: RosterEntry; state: LiveRecordingState | null; authorised: boolean; liveAuthorised: boolean }
}
const url = new URL('./recording-live.json', import.meta.url)
const published = JSON.parse(readFileSync(url, 'utf8')) as { protocolVersion: string; cases: Row[] }

describe('generated live recording interoperability fixtures', () => {
  it('pins all cases and reproduces the published file twice without rewriting it', () => {
    expect(published.protocolVersion).toBe('kithmoot/v1')
    expect(published.cases).toHaveLength(28)
    expect(new Set(published.cases.map(row => row.name)).size).toBe(28)
    const directory = mkdtempSync(join(tmpdir(), 'recording-live-vectors-'))
    try {
      for (const name of ['first.json', 'second.json']) {
        const target = join(directory, name)
        execFileSync(process.execPath, ['vectors/generate-recording-live.mjs', target])
        expect(readFileSync(target, 'utf8')).toBe(readFileSync(url, 'utf8'))
      }
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
  it.each(published.cases)('$name reproduces ciphertext/signature and keeps authority separate from presence', row => {
    const input = row.input, roomKey = hexToBytes(input.roomKeyHex)
    const event = finalizeDeterministic({ kind: KINDS.ROSTER, created_at: input.entry.updatedAt,
      tags: [['d', input.roomId]], content: nip44.v2.encrypt(JSON.stringify(input.entry), roomKey, hexToBytes(input.nonceHex)) },
      hexToBytes(input.deviceSkHex), hexToBytes(input.auxRandHex))
    expect(event).toEqual(row.event)
    const state = sanitiseLiveRecordingState(input.entry.liveRecording)
    expect(state ?? null).toEqual(row.expected.state)
    expect(!!state && verifyLiveRecordingState(input.verificationRoom, state, input.authority)).toBe(row.expected.authorised)
    const decoded = decodeRosterEvent(row.event, { roomId: input.roomId, roomKey, now: input.entry.updatedAt })
    expect(decoded).toEqual(row.expected.entry)
    expect(!!decoded?.liveRecording && verifyLiveRecordingState(input.verificationRoom, decoded.liveRecording, input.authority)).toBe(row.expected.liveAuthorised)
  })
})
