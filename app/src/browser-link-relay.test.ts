import { describe, expect, it, vi } from 'vitest'
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import { BrowserLinkRelay, linkWebSocket } from './browser-link-relay.js'
import type { LinkListener, LinkSocket } from './browser-link-types.js'
const sk = new Uint8Array(32).fill(1)
const identity = { pubkey: getPublicKey(sk), signEvent: async (e: Parameters<typeof finalizeEvent>[0]) => finalizeEvent(e, sk) }
const room = 'a'.repeat(64)
const box = { routeId: 'box', eventUrl: `ws://${'a'.repeat(52)}/events` }
const event = () => finalizeEvent({kind:1460,created_at:1,tags:[['d',room]],content:''},sk)
function carrier(challenge = true, acceptEvents = true) {
  const frames: unknown[][] = []
  let listener: LinkListener
  const socket: LinkSocket = { disconnect: vi.fn(() => listener.onClosed?.('closed')), path: () => ({status:'relayed',relay:null,direct:null,cause:''}),
    sendText: text => {
      const frame = JSON.parse(text); frames.push(frame)
      if (frame[0] === 'AUTH') queueMicrotask(() => listener.onText?.(JSON.stringify(['OK',frame[1].id,true,''])))
      if (frame[0] === 'EVENT') queueMicrotask(() => listener.onText?.(JSON.stringify(['OK',frame[1].id,acceptEvents,''])))
    } }
  const link = { openSocket: vi.fn(async (_url: string, _route: string, l: LinkListener) => {
    listener = l
    // The real WASM can receive AUTH before its openSocket promise settles.
    if (challenge) listener.onText?.(JSON.stringify(['AUTH','challenge']))
    return socket
  }) }
  return {link, frames, socket, receive: (frame: unknown[]) => listener.onText?.(JSON.stringify(frame))}
}
describe('Link relay adapter', () => {
  it('authenticates before sending room frames and delivers only verified matching events', async () => {
    const c=carrier(), pool=new BrowserLinkRelay(c.link,box,identity,{room,kinds:[1460]})
    const received=vi.fn(), eose=vi.fn()
    pool.subscribe([{kinds:[1460],'#d':[room]}],received,eose)
    const signed = event()
    await pool.publish(signed)
    expect(c.frames.map(f=>f[0])).toEqual(['AUTH','REQ','EVENT'])
    const id=c.frames[1][1]
    c.receive(['EVENT',id,{...signed,sig:'0'.repeat(128)}]); expect(received).not.toHaveBeenCalled()
    c.receive(['EVENT',id,signed]); c.receive(['EVENT',id,signed]); expect(received).toHaveBeenCalledTimes(1)
    expect(eose).not.toHaveBeenCalled(); c.receive(['EOSE',id]); expect(eose).toHaveBeenCalledOnce()
    pool.close()
  })
  it('reports an explicit negative publication acknowledgement as refused in the existing outbox', async () => {
    const c=carrier(true,false), pool=new BrowserLinkRelay(c.link,box,identity,{room,kinds:[1460]})
    await expect(pool.publish(event())).rejects.toThrow('every relay rejected the event')
    expect(pool.health()[0].lastError).toContain('Bothy refused this message')
    pool.close()
  })
  it('refuses unscoped filters and caller mutation of the original scope', async () => {
    const c=carrier(), scope={room,kinds:[1460]}, pool=new BrowserLinkRelay(c.link,box,identity,scope)
    expect(()=>pool.subscribe([{ids:[event().id]}],()=>{})).toThrow('outside')
    scope.kinds.push(1)
    await expect(pool.publish(finalizeEvent({kind:1,created_at:1,tags:[['d',room]],content:''},sk))).rejects.toThrow('outside')
    expect(c.link.openSocket).not.toHaveBeenCalled();pool.close()
  })
  it('refuses a second room tag and a different virtual address before I/O', async () => {
    const c=carrier(), pool=new BrowserLinkRelay(c.link,box,identity,{room,kinds:[1460]})
    await expect(pool.publish(finalizeEvent({kind:1460,created_at:1,tags:[['d',room],['d','b'.repeat(64)]],content:''},sk))).rejects.toThrow('outside')
    const Socket=linkWebSocket(c.link,box)
    expect(()=>new Socket('wss://public.example')).toThrow('Unpaired')
    expect(c.link.openSocket).not.toHaveBeenCalled();pool.close()
  })
  it('closes a socket that arrives after its caller cancelled', async () => {
    const c=carrier(), Socket=linkWebSocket(c.link,box), ws=new Socket(box.eventUrl)
    const opened=vi.fn();ws.onopen=opened;ws.close()
    await Promise.resolve()
    expect(c.socket.disconnect).toHaveBeenCalledOnce();expect(opened).not.toHaveBeenCalled()
  })
  it('retries a silent authentication timeout without turning it into a permanent refusal', async () => {
    vi.useFakeTimers()
    const c=carrier(false), pool=new BrowserLinkRelay(c.link,box,identity,{room,kinds:[1460]})
    try {
      pool.subscribe([{kinds:[1460],'#d':[room]}],()=>{})
      await vi.advanceTimersByTimeAsync(31_001)
      expect(c.link.openSocket).toHaveBeenCalledTimes(2)
      c.receive(['AUTH','challenge'])
      await vi.advanceTimersByTimeAsync(0)
      expect(c.frames.map(f=>f[0])).toEqual(['AUTH','REQ'])
      expect(pool.health()[0].state).toBe('connected')
    } finally { pool.close(); vi.useRealTimers() }
  })
  it('backs off repeated scope refusals even when authentication succeeds', async () => {
    vi.useFakeTimers()
    const c=carrier(), pool=new BrowserLinkRelay(c.link,box,identity,{room,kinds:[1460]})
    try {
      pool.subscribe([{kinds:[1460],'#d':[room]}],()=>{})
      await vi.advanceTimersByTimeAsync(0)
      c.receive(['CLOSED',c.frames.find(f=>f[0]==='REQ')![1],'denied'])
      await vi.advanceTimersByTimeAsync(1000)
      expect(c.link.openSocket).toHaveBeenCalledTimes(2)
      c.receive(['CLOSED',c.frames.filter(f=>f[0]==='REQ').at(-1)![1],'denied'])
      await vi.advanceTimersByTimeAsync(1000)
      expect(c.link.openSocket).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(1000)
      expect(c.link.openSocket).toHaveBeenCalledTimes(3)
    } finally { pool.close(); vi.useRealTimers() }
  })
})
