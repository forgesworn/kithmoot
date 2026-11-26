import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
// Execute the actual imported worker listener: only the worker's globals are
// stubbed. Before a room's private route changes, every KithMoot tab must say
// it is ready; a frame inside a tab (the board's editor) is not a tab.
const worker = readFileSync(new URL('../app/public/notify-sw.js', import.meta.url), 'utf8')
const scope = 'https://kithmoot.example/j/'

type Client = { url: string, frameType: 'top-level' | 'nested' | 'auxiliary', answer?: string }

async function check(clients: Client[]): Promise<{ ok: unknown, asked: string[] }> {
  const listeners: Record<string, (event: unknown) => void> = {}
  const asked: string[] = []
  const self = {
    addEventListener: (type: string, listener: (event: unknown) => void) => { listeners[type] = listener },
    registration: { scope },
    clients: {
      matchAll: async () => clients.map(client => ({ url: client.url, frameType: client.frameType,
        postMessage: (message: unknown, [port]: MessagePort[]) => {
          asked.push(client.url)
          if (message === 'kithmoot:room-route-ready-v1' && client.answer) port.postMessage(client.answer)
        } })),
    },
  }
  runInNewContext(worker, { self, URL, MessageChannel, setTimeout, clearTimeout, Promise })
  const channel = new MessageChannel()
  const answered = new Promise(resolve => { channel.port1.onmessage = event => { channel.port1.close(); resolve(event.data) } })
  let work: Promise<unknown> = Promise.resolve()
  listeners.message({ data: 'kithmoot:check-room-route-tabs-v1', ports: [channel.port2], waitUntil: (promise: Promise<unknown>) => { work = promise } })
  await work
  return { ok: await answered, asked }
}

describe('the tabs a private room route waits for', () => {
  it('asks the tab, not the board frame inside it, so a board left open never holds the change', async () => {
    const result = await check([
      { url: `${scope}?room`, frameType: 'top-level', answer: 'ready' },
      { url: `${scope}girnel/embedded/room.html`, frameType: 'nested' },
      { url: `${scope}attachment-frame.html`, frameType: 'nested' },
    ])
    expect(result).toEqual({ ok: true, asked: [`${scope}?room`] })
  })
  it('still refuses while another tab gives any answer but ready', async () => {
    const result = await check([
      { url: `${scope}?room`, frameType: 'top-level', answer: 'ready' },
      { url: `${scope}`, frameType: 'top-level', answer: 'an older build' },
    ])
    expect(result.ok).toBe(false)
    expect(result.asked).toHaveLength(2)
  })
  it('refuses when no tab at all is found', async () => {
    expect((await check([{ url: `${scope}girnel/embedded/room.html`, frameType: 'nested' }])).ok).toBe(false)
  })
})
