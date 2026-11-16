import { expect, type Page } from '@playwright/test'
import { RoomAgent } from '../src/agent.js'
import { localIdentity } from '../src/identity.js'
import { NostrRelayPool } from '../src/relay-pool.js'
import { encryptEnvelopeBlob, uploadEnvelopeBlob } from '../src/attachment.js'
import { LOCAL_TEST_RELAY, TEST_RELAY_HTTP } from './relays.js'

/** Hostile/old-client files must still be checked on receipt. Seed them
 * through the protocol; the current app now refuses to upload them. */
export async function sendLegacyAttachment(page: Page, sample: {name:string;type:string;bytes:number[]|'png'|string}, expected: number, png: string): Promise<void> {
  const secret = await page.evaluate(() => localStorage.getItem('kithmoot.participant'))
  if (!secret) throw new Error('Expected the disposable fixture identity')
  const identity = localIdentity(Uint8Array.from(secret.match(/../g)!, b => parseInt(b,16)))
  const agent = await RoomAgent.join({ link:page.url(), name:'Rowan', identity, transport:() => new NostrRelayPool([LOCAL_TEST_RELAY]) })
  try {
    const bytes = sample.bytes === 'png' ? Buffer.from(png,'base64') : typeof sample.bytes === 'string' ? new TextEncoder().encode(sample.bytes) : Uint8Array.from(sample.bytes)
    const sealed = await encryptEnvelopeBlob(new Blob([new Uint8Array(bytes)]), { name:sample.name,type:sample.type })
    try {
      const origin = new URL(page.url()).origin
      const descriptor = await uploadEnvelopeBlob(origin, sealed.envelope, sealed.sha256, { sign:event=>identity.signEvent(event), fetch:async (url,init) => fetch(String(url).replace(origin,TEST_RELAY_HTTP), {...init,headers:{...init?.headers,origin}}) })
      await agent.chat.send(sample.name, { attachments:[{url:descriptor.url,sha256:descriptor.sha256,key:sealed.key,name:sample.name,type:sample.type,size:sealed.envelope.size}] })
      await expect(page.locator('#chatLog .attachment')).toHaveCount(expected,{timeout:30000})
    } finally { await sealed.dispose?.() }
  } finally { await agent.leave() }
}
