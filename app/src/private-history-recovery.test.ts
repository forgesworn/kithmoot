import { describe, expect, it } from 'vitest'
import { HISTORY_IMPORT_MAX_EVENTS } from '../../src/history-import.js'
import { HISTORY_RECOVERY_WINDOW_SECONDS, RECOVERABLE_ADDRESSED_KINDS, RECOVERABLE_AUTHORED_KINDS, recentHistoryRecoveryRequests } from './private-history-recovery.js'

describe('private history recovery operation', () => {
  it('makes exactly two narrow, visible request classes for one bounded window', () => {
    const person = 'a'.repeat(64), until = 1_700_000_000
    const [authored, addressed] = recentHistoryRecoveryRequests(person, until)
    expect(authored).toMatchObject({ version: 1, class: 'authored', person, filter: { authors: [person], kinds: RECOVERABLE_AUTHORED_KINDS, since: until - HISTORY_RECOVERY_WINDOW_SECONDS, until, limit: HISTORY_IMPORT_MAX_EVENTS } })
    expect(addressed).toMatchObject({ version: 1, class: 'addressed', person, filter: { '#p': [person], kinds: RECOVERABLE_ADDRESSED_KINDS, since: until - HISTORY_RECOVERY_WINDOW_SECONDS, until, limit: HISTORY_IMPORT_MAX_EVENTS } })
    expect(authored.filter).not.toHaveProperty('search')
    expect(addressed.filter).not.toHaveProperty('search')
  })
})
