import test from 'node:test'
import assert from 'node:assert/strict'
import { RELAY_CHANNELS, registerRelayIpc } from '../relay-ipc.mjs'

function setup(trusted = true) {
  const handlers = new Map(), listeners = new Map(), calls = []
  const ipcMain = { on: (channel, fn) => listeners.set(channel, fn), handle: (channel, fn) => handlers.set(channel, fn) }
  const hosting = {
    setContext: value => calls.push(['context', value]),
    start: options => { calls.push(['start', options]); return Promise.resolve() },
    stop: async () => { calls.push(['stop']); return true },
    setStartOnOpen: async on => { calls.push(['startOnOpen', on]) },
    removeKeys: async () => { calls.push(['removeKeys']); return true },
  }
  registerRelayIpc({ ipcMain, hosting, allowed: event => event.trusted === true && trusted, view: () => ({ state: { status: 'off' } }) })
  return { handlers, listeners, calls }
}
const main = { trusted: true }
const stranger = { trusted: false }

test('the relay channels answer the trusted main frame', async () => {
  const { handlers, listeners, calls } = setup()
  assert.deepEqual(await handlers.get(RELAY_CHANNELS.state)(main), { state: { status: 'off' } })
  listeners.get(RELAY_CHANNELS.context)(main, { participant: 'x' })
  assert.equal(await handlers.get(RELAY_CHANNELS.start)(main), true)
  assert.equal(await handlers.get(RELAY_CHANNELS.stop)(main), true)
  assert.equal(await handlers.get(RELAY_CHANNELS.startOnOpen)(main, true), true)
  assert.equal(await handlers.get(RELAY_CHANNELS.removeKeys)(main), true)
  assert.deepEqual(calls, [['context', { participant: 'x' }], ['start', { person: true }], ['stop'], ['startOnOpen', true], ['removeKeys']])
})

test('a sender that is not the main frame is ignored on every channel', async () => {
  const { handlers, listeners, calls } = setup()
  assert.equal(await handlers.get(RELAY_CHANNELS.state)(stranger), null)
  listeners.get(RELAY_CHANNELS.context)(stranger, { participant: 'x' })
  assert.equal(await handlers.get(RELAY_CHANNELS.start)(stranger), false)
  assert.equal(await handlers.get(RELAY_CHANNELS.stop)(stranger), false)
  assert.equal(await handlers.get(RELAY_CHANNELS.startOnOpen)(stranger, true), false)
  assert.equal(await handlers.get(RELAY_CHANNELS.removeKeys)(stranger), false)
  assert.deepEqual(calls, [])
})

test('start on open takes only a real boolean', async () => {
  const { handlers, calls } = setup()
  for (const bad of [undefined, null, 1, 0, 'true', {}, [true]]) assert.equal(await handlers.get(RELAY_CHANNELS.startOnOpen)(main, bad), false)
  assert.deepEqual(calls, [])
  assert.equal(await handlers.get(RELAY_CHANNELS.startOnOpen)(main, false), true)
  assert.deepEqual(calls, [['startOnOpen', false]])
})
