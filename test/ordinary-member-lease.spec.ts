import { build } from 'esbuild'
import { expect, test } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { setup, actorFixture } from './ordinary-bootstrap.setup.js'
import { leaseFixture } from './ordinary-member-lease.setup.js'

const ORIGIN = 'https://ordinary-member-lease.kithmoot.test'
let bundle = ''
test.beforeAll(async () => {
  bundle = (await build({ entryPoints: [fileURLToPath(new URL('./ordinary-member-lease.browser-entry.ts', import.meta.url))],
    bundle: true, format: 'iife', globalName: 'Ordinary', platform: 'browser', write: false, target: 'es2022' })).outputFiles[0]!.text
})
test.beforeEach(async ({ context, page }) => {
  await context.route(ORIGIN + '/**', route => route.fulfill({ status: 200, contentType: 'text/html',
    body: '<!doctype html><script>' + bundle.replace(/<\/script/gi, '<\\/script') + '</script>' }))
  await page.goto(ORIGIN)
})
async function start(page: import('@playwright/test').Page, options = {}) {
  await page.evaluate('(' + setup + ')(' + JSON.stringify(options) + ')')
  await page.evaluate('(' + leaseFixture + ')(' + JSON.stringify(options) + ')')
}
for (const keep of [true,false]) for (const visitor of [true,false]) {
  test('real signed successor and native pair remain composable, keep=' + keep + ', visitor=' + visitor, async ({ page }) => {
    await start(page, { keep, visitor })
    expect(await page.evaluate(`(async()=>{
      const c=await renew(),[b,t]=await images(),name=Ordinary.ordinaryMemberLeaseName(c.next.binding),lease=Ordinary.readOrdinaryMemberLease(c.lease,JSON.stringify(c.next))
      await preflight()
      const out=[lease.header.sequence,lease.header.bootstrap===c.old.binding.operation,lease.header.predecessor===lease.predecessorHeader.operation,
        lease.header.expiresAt>lease.predecessorHeader.expiresAt,lease.header.authority.foregroundExpiresAt,
        lease.header.authority.tabExpiresAt===tabExpiry,lease.header.authority.admissionEndsAt===now+3600,
        b.records.get(name)===t.records.get(name),b.records.has(name),b.records.has(prefix+Ordinary.DEVICE_PREFIX+roomId),
        b.revision>lease.header.source.browserRevision,t.revision>lease.header.source.tabRevision,Object.keys(localStorage),Object.keys(sessionStorage)]
      return out
    })()`)).toEqual([1,true,true,true,null,true,true,keep,keep,keep,true,true,[],[]])
  })
}
test('immediate lineage advances without recursive lease growth and preserves signed admission bytes', async ({ page }) => {
  await start(page, { visitor: true })
  expect(await page.evaluate(`(async()=>{
    const first=await renew(),second=await renew(),a=JSON.parse(first.lease),b=JSON.parse(second.lease)
    await preflight()
    return[b.header.sequence,b.predecessorHeader.operation===a.header.operation,b.bootstrapProof===a.bootstrapProof,
      b.predecessorProof===JSON.stringify(first.next),b.header.source.browserRevision>a.header.source.browserRevision,
      b.header.source.tabRevision>a.header.source.tabRevision,JSON.stringify(b.header.authority)===JSON.stringify(b.predecessorHeader.authority),
      Object.keys(b),b.predecessorHeader.predecessor===a.predecessorHeader.operation,second.next.kept.at===first.old.kept.at]
  })()`)).toEqual([2,true,true,true,true,true,true,
    ['version','domain','header','bootstrapProof','predecessorProof','predecessorHeader'],true,true])
})
test('unrelated writes do not invalidate historical predecessor commitment or selected lease', async ({ page }) => {
  await start(page, { visitor: true })
  expect(await page.evaluate(`(async()=>{
    const c=await renew(),before=c.lease
    await pair((b,t)=>{b.set('kithmoot.nudge.'+roomId,'true');t.set('kithmoot.notice','kept')})
    await preflight();const[b,t]=await images(),name=Ordinary.ordinaryMemberLeaseName(c.next.binding)
    return[b.records.get(name)===before,t.records.get(name)===before,b.revision>c.source.browserRevision+1,t.revision>c.source.tabRevision+1]
  })()`)).toEqual([true,true,true,true])
})
for (const keep of [true,false]) test('native owner restart authenticates retained successor, keep=' + keep, async ({ page }) => {
  await start(page, { visitor: true, keep })
  expect(await page.evaluate(`(async()=>{
    const c=await renew(),before=await records();await Promise.all([browserOwner.close(),tabOwner.close()])
    browserOwner=new Ordinary.OrdinaryStateOwner();tabOwner=new Ordinary.OrdinaryStateOwner(tabPurpose,tabExpiry)
    const migration={phase:'complete',sources:new Map(),names:[]};countCrypto()
    try{await browserOwner.prepare(guard,new Map(),migration);await tabOwner.prepare(guard,new Map(),migration);await preflight()
      const reopened=[entropy,encryptions];restoreCrypto();const next=await candidate();await prepare(next)
      return[...reopened,JSON.stringify(before)===JSON.stringify(await records()),JSON.parse(next.lease).header.sequence]
    }finally{restoreCrypto()}
  })()`)).toEqual([0,0,true,2])
})
test('historical bootstrap proof verifies after its original private seal is absent', async ({ page }) => {
  await start(page, { visitor: true, keep: false })
  expect(await page.evaluate(`(async()=>{
    const c=await renew()
    await pair((b,t)=>{const name=prefix+Ordinary.OWN_SEAL_PREFIX+roomId,seals=JSON.parse(t.get(name));t.set(name,JSON.stringify([seals.at(-1)]))})
    await preflight();const lease=Ordinary.readOrdinaryMemberLease(c.lease,JSON.stringify(c.next));return lease.bootstrapProof===JSON.stringify(c.old)
  })()`)).toBe(true)
})
test('Fore expiry is taken from exact genuine native custody and rounds down', async ({ page }) => {
  await start(page, { foregroundMs: 2500999, noEnds: true })
  expect(await page.evaluate(`(async()=>{
    const c=await candidate({expiry:now+2500});await prepare(c);await commit(c);await preflight()
    const h=JSON.parse(c.lease).header
    const tooLate=await candidate({expiry:now+2501});let refused;try{await prepare(tooLate)}catch(e){refused=e.name}
    return[h.authority.foregroundExpiresAt===now*1000+2500999,Ordinary.ordinaryMemberAuthorityUntil(h.authority)===now+2500,refused]
  })()`)).toEqual([true,true,'OrdinaryStateHold'])
})
test('tab expiry is rounded down with no admission or Fore expiry', async ({ page }) => {
  await start(page, { visitor: true, noEnds: true })
  expect(await page.evaluate(`(async()=>{
    const limit=Math.floor(tabExpiry/1000),c=await candidate({expiry:limit});await prepare(c);await commit(c);await preflight()
    const a=JSON.parse(c.lease).header.authority;let refused;try{const invalid=await candidate({expiry:limit+1});await prepare(invalid)}catch(e){refused=e.name}
    return[Ordinary.ordinaryMemberAuthorityUntil(a)===limit,a.admissionEndsAt,a.foregroundExpiresAt,refused]
  })()`)).toEqual([true,null,null,'OrdinaryStateHold'])
})
for (const fault of ['fake-fore','absent-fore','different-session','changed-sdk-expiry','mutated-public-deadline'] as const) {
  test('native preparation refuses account provenance fault ' + fault, async ({ page }) => {
    await start(page)
    expect(await page.evaluate(`(async()=>{
      const c=await candidate(),fault='${fault}';let fake
      if(fault==='fake-fore')fake={pubkey:participant,session:{expiresAt:now*1000+9000000}}
      if(fault==='different-session')sourceSession={...sourceSession}
      if(fault==='changed-sdk-expiry')await pair(b=>b.set('signet:login.expiresAt',String(now*1000+3000000)))
      if(fault==='mutated-public-deadline')identity.session={...identity.session,expiresAt:now*1000+9000000}
      countCrypto();const before=await records();let result
      try{const raw=await prepare(c,fault==='fake-fore'?{identity:fake}:fault==='absent-fore'?{identity:undefined}:{});
        result=JSON.parse(raw).header.authority.foregroundExpiresAt}catch(e){result=e.name}
      const output=[result,entropy,encryptions,JSON.stringify(before)===JSON.stringify(await records())];restoreCrypto();return output
    })()`)).toEqual(['OrdinaryStateHold',0,0,true])
  })
}
test('sign-out preserves historical lease custody and refuses new account preparation', async ({ page }) => {
  await start(page, { foregroundMs: 3000000 })
  expect(await page.evaluate(`(async()=>{
    const c=await renew(),next=await candidate();await identity.close();sourceSession=null
    await pair(b=>{for(const key of Object.values(Ordinary.ORDINARY_SIGNET_KEYS))b.remove(key)})
    await preflight();const name=Ordinary.ordinaryMemberLeaseName(c.next.binding),[b,t]=await images()
    return[b.records.get(name)===c.lease,t.records.get(name)===c.lease,await outcome(()=>prepare(next))]
  })()`)).toEqual([true,true,'OrdinaryStateHold'])
})
test('different genuine Signet account with identical expiry gains no renewal authority', async ({ page }) => {
  await start(page, { foregroundMs: 3000000 })
  expect(await page.evaluate(`(async()=>{
    const c=await renew(),next=await candidate(),expiry=sourceSession.expiresAt,newKey=new Uint8Array(32).fill(18),newPubkey=Ordinary.getPublicKey(newKey)
    await identity.close();await pair(b=>{for(const key of Object.values(Ordinary.ORDINARY_SIGNET_KEYS))b.remove(key)})
    const storage=await Ordinary.OrdinarySignetState.open({owner:browserOwner,generation:0,currentGeneration:()=>0,live:guard,
      origin:location.origin,appName:'KithMoot',checkClients:async()=>{},stop:()=>{}})
    window.nostr={getPublicKey:async()=>newPubkey,signEvent:async event=>Ordinary.finalizeEvent(event,newKey)}
    sourceSession=await Ordinary.login({preferredMethod:'nip07',appName:'KithMoot',storage})
    await pair(b=>b.set('signet:login.expiresAt',String(expiry)));sourceSession={...sourceSession,expiresAt:expiry}
    identity=await Ordinary.OrdinaryForegroundSigner.open({browser:browserOwner,tab:tabOwner,session:sourceSession,currentSession:()=>sourceSession,
      generation:0,currentGeneration:()=>0,live:guard,checkClients:async()=>{},stop:()=>{}})
    await preflight();const held=await outcome(()=>prepare(next)),privateBinding=await outcome(()=>readPair((b,t,_bn,_tn,token)=>
      Ordinary.OrdinaryForegroundSigner.nativeDeadline(identity,b,t,token,participant)))
    return[sourceSession.pubkey!==participant,sourceSession.expiresAt===expiry,held,privateBinding,JSON.parse(c.lease).header.authority.foregroundExpiresAt===expiry]
  })()`)).toEqual([true,true,'OrdinaryStateHold','OrdinaryStateHold',true])
})
test('predecessor commitment is canonical across record and fence insertion order', async ({ page }) => {
  await start(page, { visitor: true })
  expect(await page.evaluate(`(async()=>{
    const s=await scopes(),z=await browserOwner.capture('z',guard),a=await browserOwner.capture('a',guard)
    await browserOwner.forget(z,guard,()=>false);await browserOwner.forget(a,guard,()=>false)
    return readPair((b,t,_bn,_tn,token)=>{
      const reversed=store=>({get:n=>store.get(n),keys:()=>store.keys().reverse(),set:()=>{throw Error()},remove:()=>{throw Error()}})
      const first=Ordinary.ordinaryMemberLeaseSource(b,t,token),second=Ordinary.ordinaryMemberLeaseSource(reversed(b),reversed(t),token)
      const headers=Ordinary.ordinaryPairReadCustodyFor(token,stored(b),stored(t)),sort=map=>[...map].sort(([a],[b])=>a<b?-1:a>b?1:0)
      const image=(h,r)=>[h.purpose,h.expiresAt,h.generation,h.revision,sort(h.fences),sort(r)]
      const hash=Ordinary.memberLeaseDigest(['kithmoot/member-lease/v1/source',1,image(headers.browser,stored(b)),image(headers.tab,stored(t))])
      const reversedFenceHash=Ordinary.memberLeaseDigest(['kithmoot/member-lease/v1/source',1,[headers.browser.purpose,headers.browser.expiresAt,
        headers.browser.generation,headers.browser.revision,[...headers.browser.fences].reverse(),sort(stored(b))],image(headers.tab,stored(t))])
      return[first.hash===second.hash,first.hash===hash,first.hash!==reversedFenceHash]
    })
  })()`)).toEqual([true,true,true])
})
for (const fault of ['fabricated-token','stale-token','mutation-projection','changed-bytes','wrong-owner'] as const) {
  test('source commitment refuses native provenance fault ' + fault, async ({ page }) => {
    await start(page, { visitor: true })
    expect(await page.evaluate(`(async()=>{
      const fault='${fault}';let captured
      await readPair((b,t,_bn,_tn,c)=>{captured={b:stored(b),t:stored(t),c}})
      const invoke=()=>Ordinary.ordinaryMemberLeaseSource(storeView(captured.b),storeView(captured.t),fault==='fabricated-token'?{}:captured.c)
      if(fault==='changed-bytes')captured.b.set('kithmoot.nudge.'+roomId,'true')
      if(fault==='wrong-owner')await browserOwner.close()
      let result
      try{if(fault==='mutation-projection')await pair((b,t,_bn,_tn,c)=>Ordinary.ordinaryMemberLeaseSource(b,t,c));else invoke();result='unexpected'}catch(e){result=e.name}
      return result
    })()`)).toBe('OrdinaryStateHold')
  })
}
for (const fault of ['membership','authority-extension','non-increasing-expiry','non-increasing-time','sequence-gap','wrong-predecessor','wrong-bootstrap',
  'unsigned-current','unsigned-bootstrap','unsigned-predecessor','header-hash','extra-field','nested-lease','reordered-header','byte-limit'] as const) {
  test('strict signed lineage refuses ' + fault, async ({ page }) => {
    await start(page, { visitor: true })
    expect(await page.evaluate(`(async()=>{
      const c=await candidate();await prepare(c);const value=JSON.parse(c.lease),fault='${fault}',h=value.header,p=value.predecessorHeader
      if(fault==='membership')h.authority.membershipEndsAt=now+9999
      if(fault==='authority-extension')h.authority.admissionEndsAt+=1
      if(fault==='non-increasing-expiry')h.expiresAt=p.expiresAt
      if(fault==='non-increasing-time')h.issuedAt=p.issuedAt
      if(fault==='sequence-gap')h.sequence=3
      if(fault==='wrong-predecessor')h.predecessor='f'.repeat(64)
      if(fault==='wrong-bootstrap')h.bootstrap='f'.repeat(64)
      if(fault==='unsigned-current'){const proof=JSON.parse(JSON.stringify(c.next));proof.binding.device.credentials[0]=proof.binding.device.credentials[0].replace(/"sig":"[a-f0-9]+"/,'"sig":"'+'0'.repeat(128)+'"');c.next=proof}
      if(fault==='unsigned-bootstrap'||fault==='unsigned-predecessor'){const field=fault==='unsigned-bootstrap'?'bootstrapProof':'predecessorProof',
        proof=JSON.parse(value[field]),event=JSON.parse(proof.evidence.events[0]);event.sig='0'.repeat(128);proof.evidence.events[0]=JSON.stringify(event);value[field]=JSON.stringify(proof)}
      if(fault==='extra-field')value.extra=true
      if(fault==='nested-lease')value.predecessorHeader=JSON.parse(c.lease)
      if(fault!=='nested-lease')h.operation=headerHash(h)
      if(fault==='header-hash')h.operation='f'.repeat(64)
      if(fault==='reordered-header'){const{sequence,...rest}=h;value.header={...rest,sequence}}
      let result;try{const raw=fault==='byte-limit'?' '.repeat(Ordinary.MAX_MEMBER_LEASE_BYTES+1):JSON.stringify(value);
        Ordinary.readOrdinaryMemberLease(raw,JSON.stringify(c.next));result='unexpected'}catch(e){result=e.name}
      return result
    })()`)).toBe('OrdinaryStateHold')
  })
}
for (const fault of ['orphan-browser','orphan-tab','missing-tab-copy','different-pair-bytes','optout-browser-copy','wrong-slot','replaced-proof'] as const) {
  test('complete composer refuses lease topology ' + fault, async ({ page }) => {
    await start(page, { visitor: true, keep: fault!=='optout-browser-copy' })
    expect(await page.evaluate(`(async()=>{
      const c=await renew(),name=Ordinary.ordinaryMemberLeaseName(c.next.binding),fault='${fault}'
      await pair((b,t)=>{
        if(fault==='orphan-browser')b.remove(proofName)
        if(fault==='orphan-tab')t.remove(tabProofName)
        if(fault==='missing-tab-copy')t.remove(name)
        if(fault==='different-pair-bytes')t.set(name,c.lease+' ')
        if(fault==='optout-browser-copy')b.set(name,c.lease)
        if(fault==='wrong-slot'){t.remove(name);t.set(name.slice(0,-64)+'f'.repeat(64),c.lease)}
        if(fault==='replaced-proof'){if(keep)b.set(proofName,JSON.stringify(c.old));t.set(tabProofName,Ordinary.tabProofBytes(c.old))}
      })
      const before=await records(),result=await outcome(preflight)
      return[result,JSON.stringify(before)===JSON.stringify(await records())]
    })()`)).toEqual(['OrdinaryStateHold',true])
  })
}
test('historical browser slot remains inert with an unrelated fresh tab', async ({ page }) => {
  await start(page, { visitor: true })
  expect(await page.evaluate(`(async()=>{
    const c=await renew();await tabOwner.close();tabPurpose='tab:'+'b'.repeat(64);tabExpiry=Date.now()+3600_000
    tabOwner=new Ordinary.OrdinaryStateOwner(tabPurpose,tabExpiry);await tabOwner.prepare(guard,new Map(),{phase:'complete',sources:new Map(),names:[]})
    const counts=await preflight();return[counts.identities,(await images())[1].records.size,await outcome(()=>prepare(c))]
  })()`)).toEqual([1,0,'OrdinaryStateHold'])
})
test('definite predecessor mismatch refuses a delayed fixture before allocating ciphertext', async ({ page }) => {
  await start(page, { visitor: true })
  expect(await page.evaluate(`(async()=>{
    const first=await candidate();await prepare(first);await renew();countCrypto()
    let result;try{await commit(first);result='unexpected'}catch(e){result=e.name}
    const out=[result,entropy,encryptions];restoreCrypto();await preflight();return out
  })()`)).toEqual(['OrdinaryStateHold',0,0])
})
test('schema acceptance does not enable the first-credential Session factory to use a successor', async ({ page }) => {
  await start(page, { visitor: true })
  expect(await page.evaluate(`(async()=>{
    await renew();bootstrap=await open();countCrypto();let dials=0
    class Socket{constructor(){dials++}}
    const loaded=await outcome(()=>bootstrap.load()),session=await outcome(()=>bootstrap.openMemberSession({relays:['wss://signed.example/'],
      profile:'direct',websocketImplementation:Socket,live:guard}));const out=[loaded,session,dials,entropy,encryptions];restoreCrypto();return out
  })()`)).toEqual(['OrdinaryStateHold','OrdinaryStateHold',0,0,0])
})
for (const keep of [true,false]) test('native forget deletes its lease and proof while preserving another actor, keep=' + keep, async ({ page }) => {
  await start(page, { visitor: true, keep })
  await page.evaluate('renew()')
  await page.evaluate('window.otherActor=(' + actorFixture + ')')
  await page.evaluate(`(async()=>{
    const ownSecret=secret,ownRoom=roomId,priorFixed=(await images())[0].records.get(Ordinary.FIXED_INVITATION_RELAYS)
    try{secret=new Uint8Array(32).fill(47);roomId=Ordinary.deriveRoom(secret).roomId
      await otherActor(Array.from(new Uint8Array(32).fill(19)),Array.from(new Uint8Array(32).fill(21)))}
    finally{secret.fill(0);secret=ownSecret;roomId=ownRoom}
    if(priorFixed!==undefined)await pair(b=>b.set(Ordinary.FIXED_INVITATION_RELAYS,
      JSON.stringify({...JSON.parse(priorFixed),...JSON.parse(b.get(Ordinary.FIXED_INVITATION_RELAYS))})))
  })()`)
  expect(await page.evaluate(`(async()=>{
    const before=(await images())[0].records,otherPrefix='kithmoot.account.'+Ordinary.getPublicKey(new Uint8Array(32).fill(19))+'.',
      other=[...before].filter(([n])=>n.startsWith(otherPrefix))
    bootstrap=await open();await bootstrap.forget();const[b,t]=await images();await preflight()
    return[[...b.records.keys(),...t.records.keys()].filter(n=>n.startsWith(prefix)&&n.includes(Ordinary.MEMBER_LEASE_PREFIX)).length,
      b.records.has(proofName),t.records.has(tabProofName),other.length>0,other.every(([n,v])=>b.records.get(n)===v)]
  })()`)).toEqual([0,false,false,true,true])
})
