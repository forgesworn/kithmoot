import { build } from 'esbuild'
import { expect, test } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { setup } from './ordinary-persistent-admission.setup.js'

const ORIGIN = 'https://ordinary-tab-device.kithmoot.test'
let bundle = ''
test.beforeAll(async () => {
  const built = await build({ entryPoints: [fileURLToPath(new URL('./ordinary-persistent-admission.browser-entry.ts', import.meta.url))],
    bundle: true, format: 'iife', globalName: 'Ordinary', platform: 'browser', write: false, target: 'es2022' })
  bundle = built.outputFiles[0]!.text
})
test.beforeEach(async ({ context, page }) => {
  await context.route(`${ORIGIN}/**`, route => route.fulfill({ status: 200, contentType: 'text/html',
    body: `<!doctype html><script>${bundle.replace(/<\/script/gi, '<\\/script')}</script>` }))
  await page.goto(ORIGIN)
})
// This is a custody fixture, not a production bootstrap or signing adapter.
// It deliberately starts from actual v1 query/credential writer records, then
// changes device placement and writes an explicit v2 proof in one native pair.
async function start(page: import('@playwright/test').Page, options: { browser?: boolean; visitor?: boolean; shortLease?: boolean; noEnds?: boolean } = {}) {
  await page.evaluate(`(${setup})(${JSON.stringify({ keep: !!options.browser, visitor: !!options.visitor, leaseMs: options.shortLease ? 1800_000 : 3600_000, noEnds: !!options.noEnds })})`)
  await page.evaluate(`(async()=>{
    const admission=await request();admission.secret.fill(0)
    const [initialBrowser,initialTab]=await images()
    const old=JSON.parse(${options.browser ? 'initialBrowser.records.get(proofName)' : 'initialTab.records.get(tabProofName).toString()'} )
    window.original=${options.browser ? 'old' : 'old.privateProof'}
    window.oldMember=await open();await member.close();await devices.close()
    window.bScope=await browserOwner.capture('invitation:'+id,guard)
    window.tScope=await tabOwner.capture('invitation:'+id,guard)
    window.custodyOwner=${JSON.stringify(options.browser ? 'browser' : 'tab')}
    window.dScope=await (custodyOwner==='browser'?browserOwner:tabOwner).capture('room:'+roomId,guard)
    window.deviceCustody={owner:custodyOwner,scope:{...dScope,...(custodyOwner==='tab'?{purpose:tabPurpose,expiresAt:tabExpiry}:{})}}
    window.credential=await Ordinary.createDeviceCredential({identity,devicePubkey:Ordinary.getPublicKey(deviceSk),roomId,
      expiresAt:now+${options.shortLease ? 900 : 1800},now:()=>now,seal:Ordinary.getPublicKey(seal)})
    window.pair=(work)=>Ordinary.OrdinaryStateOwner.mutatePairMigrated({browser:{owner:browserOwner,scope:bScope},tab:{owner:tabOwner,scope:tScope},live:guard,work})
    window.proofInput=(b,t)=>({invitation,evidence:original.evidence,account,participant,browser:bScope,
      tab:{...tScope,purpose:tabPurpose,expiresAt:tabExpiry},device:Ordinary.persistentAdmissionDeviceInPair(b,t,roomId,participant,account,custodyOwner),
      keep,now,expectedRoomSecret:secret,deviceCustody})
    await pair((b,t)=>{
      b.set(prefix+Ordinary.OWN_CREDENTIAL_PREFIX+roomId,JSON.stringify(credential))
      if(custodyOwner==='tab'){
        for(const name of b.keys())if(Ordinary.classifyOrdinaryPhysicalName(name,'browser')?.family==='identity'&&name.startsWith(prefix)){
          t.set(name,b.get(name));b.remove(name)
        }
      }
      const verified=Ordinary.makePersistentAdmissionProof(proofInput(b,t));window.v2=verified.proof
      window.v2name=Ordinary.persistentProofName(v2.binding);window.v2tabName=Ordinary.persistentTabProofName(v2.binding)
      b.remove(proofName);t.remove(tabProofName)
      if(keep)b.set(v2name,JSON.stringify(v2))
      t.set(v2tabName,Ordinary.tabProofBytes(v2));verified.admission.secret.fill(0)
    })
    window.check=()=>preflight()
    window.rewrite=(change)=>pair((b,t)=>{
      const input=proofInput(b,t);change(input,b,t)
      const verified=Ordinary.makePersistentAdmissionProof(input);v2=verified.proof
      if(keep)b.set(v2name,JSON.stringify(v2));t.set(v2tabName,Ordinary.tabProofBytes(v2));verified.admission.secret.fill(0)
    })
  })()`)
}

test('native opt-out binds actual tab primary, signed evidence, room scope and lease without browser device/root/fixed rows', async ({ page }) => {
  await start(page, { visitor: true })
  expect(await page.evaluate(`(async()=>{
    const counts=await check(),[b,t]=await images()
    const read=Ordinary.readPersistentAdmissionProof(JSON.stringify(v2));read.admission.secret.fill(0)
    return [v2.version,v2.domain,v2.binding.deviceCustody.owner,v2.binding.deviceCustody.scope,
      v2.binding.account,v2.binding.device.pubkey===Ordinary.getPublicKey(deviceSk),counts.identities,
      [...b.records.keys()].filter(n=>Ordinary.classifyOrdinaryPhysicalName(n,'browser')?.family==='identity'),
      b.records.has(v2name),b.records.has(prefix+Ordinary.KEPT_ADMISSION_PREFIX+id),b.records.has(Ordinary.FIXED_INVITATION_RELAYS),
      t.records.has(prefix+Ordinary.DEVICE_PREFIX+roomId),JSON.parse(t.records.get(v2tabName)).privateProof.version,
      Object.keys(localStorage),Object.keys(sessionStorage)]
  })()`)).toEqual([2, 'kithmoot/persistent-admission-proof/v2', 'tab', await page.evaluate('deviceCustody.scope'),
    null, true, 1, ['kithmoot.participant'], false, false, false, true, 2, [], []])
})

test('v2 browser custody is explicit and v1 canonical proof remains byte-for-byte readable', async ({ page }) => {
  await start(page, { browser: true })
  expect(await page.evaluate(`(async()=>{
    await check();const raw=JSON.stringify(original),read=Ordinary.readPersistentAdmissionProof(raw)
    const result=[v2.version,v2.binding.deviceCustody.owner,read.proof.version,JSON.stringify(read.proof)===raw,
      !Object.hasOwn(read.proof.binding,'deviceCustody'),v2name.includes('.v2.'),v2tabName.includes('.v2.')]
    read.admission.secret.fill(0);return result
  })()`)).toEqual([2, 'browser', 1, true, true, true, true])
})

test('native reopen preserves tab-device proof bytes and does not mint new ciphertext', async ({ page }) => {
  await start(page)
  expect(await page.evaluate(`(async()=>{
    const before=await records();await Promise.all([browserOwner.close(),tabOwner.close()])
    const migration={phase:'complete',sources:new Map(),names:[]},encrypt=crypto.subtle.encrypt.bind(crypto.subtle)
    crypto.subtle.encrypt=async()=>{throw Error('unexpected new ciphertext')}
    browserOwner=new Ordinary.OrdinaryStateOwner();tabOwner=new Ordinary.OrdinaryStateOwner(tabPurpose,tabExpiry)
    try{await browserOwner.prepare(guard,new Map(),migration);await tabOwner.prepare(guard,new Map(),migration);await check()
      return JSON.stringify(before)===JSON.stringify(await records())}finally{crypto.subtle.encrypt=encrypt}
  })()`)).toBe(true)
})

test('browser saved keep:false link remains composable with a fresh empty tab after opt-out custody expires', async ({ page }) => {
  await start(page, { visitor: true })
  expect(await page.evaluate(`(async()=>{
    const before=(await images())[0].records;await tabOwner.close()
    tabPurpose='tab:'+'b'.repeat(64);tabExpiry=Date.now()+3600_000;tabOwner=new Ordinary.OrdinaryStateOwner(tabPurpose,tabExpiry)
    await tabOwner.prepare(guard,new Map(),{phase:'complete',sources:new Map(),names:[]})
    const counts=await check(),[b,t]=await images()
    return [counts.identities,b.records.has(prefix+Ordinary.ROOM_PREFIX+roomId),JSON.stringify([...before])===JSON.stringify([...b.records]),t.records.size]
  })()`)).toEqual([0, true, true, 0])
})

for (const fault of ['duplicate-device', 'duplicate-name', 'split-group', 'unproved-tab', 'room-fence', 'browser-room-fence', 'tab-epoch', 'browser-epoch', 'fixed-row', 'unsigned-fixed-row'] as const) {
  test(`full native composer holds ${fault} without repairing custody`, async ({ page }) => {
    await start(page, { browser: fault === 'browser-room-fence' })
    expect(await page.evaluate(`(async()=>{
      await pair((b,t)=>{
        const fault=${JSON.stringify(fault)},name=prefix+Ordinary.DEVICE_PREFIX+roomId
        if(fault==='duplicate-name')b.set(name,t.get(name))
        if(fault==='split-group'){b.set(name,t.get(name));t.remove(name)}
        if(fault==='unproved-tab')t.remove(v2tabName)
        if(fault==='duplicate-device'){
          const otherRoom='c'.repeat(64),otherPrefix='kithmoot.account.'+'d'.repeat(64)+'.'
          b.set(otherPrefix+Ordinary.DEVICE_PREFIX+otherRoom,t.get(name))
          b.set(otherPrefix+'kithmoot.device-owner.'+otherRoom,JSON.stringify({account:'d'.repeat(64),roomId:otherRoom}))
        }
        if(fault==='tab-epoch')t.set(prefix+'kithmoot.room-epoch.v1.'+roomId,'{}')
        if(fault==='browser-epoch'){
          const epoch=Ordinary.deriveEpoch({epoch:1,secret:new Uint8Array(32).fill(43)})
          b.set(prefix+'kithmoot.room-epoch.v1.'+roomId,JSON.stringify({epoch:1,id:epoch.id,key:Ordinary.bytesToHex(epoch.key)}));epoch.key.fill(0)
        }
        if(fault==='fixed-row'||fault==='unsigned-fixed-row')b.set(Ordinary.FIXED_INVITATION_RELAYS,JSON.stringify({[roomId]:{c:['wss://signed.example/'],signed:fault==='fixed-row'}}))
      })
      if(${JSON.stringify(fault)}==='room-fence'||${JSON.stringify(fault)}==='browser-room-fence'){
        const owner=custodyOwner==='browser'?browserOwner:tabOwner
        await owner.forget(dScope,guard,()=>false)
      }
      const before=await records(),result=await outcome(check)
      return [result,JSON.stringify(before)===JSON.stringify(await records())]
    })()`)).toEqual(['OrdinaryStateHold', true])
  })
}

for (const fault of ['owner', 'room', 'generation', 'purpose', 'lease', 'ends-bound', 'lease-bound', 'keep', 'epoch'] as const) {
  test(`v2 construction refuses ${fault} binding`, async ({ page }) => {
    await start(page, { noEnds: fault === 'lease-bound', shortLease: fault === 'lease-bound' })
    expect(await page.evaluate(`(async()=>{
      return outcome(()=>rewrite((input,b,t)=>{
        const fault=${JSON.stringify(fault)}
        if(fault==='owner')input.deviceCustody.owner='elsewhere'
        if(fault==='room')input.deviceCustody.scope.name='room:'+'f'.repeat(64)
        if(fault==='generation')input.deviceCustody.scope.generation='f'.repeat(64)
        if(fault==='purpose')input.deviceCustody.scope.purpose='tab:'+'f'.repeat(64)
        if(fault==='lease')input.deviceCustody.scope.expiresAt++
        if(fault==='keep')input.keep=true
        if(fault==='epoch'){
          const {recordsHash,...base}=input.device
          base.epoch=1;base.epochs=[{epoch:0,id:roomId},{epoch:1,id:'f'.repeat(64)}]
          input.device={...base,recordsHash:Ordinary.bytesToHex(Ordinary.sha256(new TextEncoder().encode(JSON.stringify(['kithmoot/persistent-admission-proof/v1/device',base]))))}
        }
        if(fault==='ends-bound'||fault==='lease-bound'){
          const event=JSON.parse(t.get(prefix+Ordinary.OWN_CREDENTIAL_PREFIX+roomId))
          const expires=fault==='ends-bound'?now+3601:Math.floor(tabExpiry/1000)+1
          const signed=Ordinary.finalizeEvent({kind:event.kind,created_at:event.created_at,
            tags:event.tags.map(tag=>tag[0]==='expiration'?['expiration',String(expires)]:tag),content:event.content},participantSk)
          t.set(prefix+Ordinary.OWN_CREDENTIAL_PREFIX+roomId,JSON.stringify(signed))
          input.device=Ordinary.persistentAdmissionDeviceInPair(b,t,roomId,participant,account,'tab')
        }
      }))
    })()`)).toBe('OrdinaryStateHold')
  })
}

test('v1 proof cannot inherit a tab device through downgrade or owner-search fallback', async ({ page }) => {
  await start(page)
  expect(await page.evaluate(`(async()=>{
    await pair((b,t)=>{
      const input=proofInput(b,t);delete input.deviceCustody
      const legacy=Ordinary.makePersistentAdmissionProof(input)
      t.remove(v2tabName);t.set(Ordinary.persistentTabProofName(legacy.proof.binding),Ordinary.tabProofBytes(legacy.proof))
      legacy.admission.secret.fill(0)
    });return outcome(check)
  })()`)).toBe('OrdinaryStateHold')
})

test('same invitation cannot select both v1 and v2 tab proof slots', async ({ page }) => {
  await start(page, { browser: true })
  expect(await page.evaluate(`(async()=>{
    await pair((b,t)=>{b.set(proofName,JSON.stringify(original));t.set(tabProofName,Ordinary.tabProofBytes(original))})
    return outcome(check)
  })()`)).toBe('OrdinaryStateHold')
})

for(const browser of [false,true])test(`canonical creation ignores reversed caller scope order, browser=${browser}`,async({page})=>{
  await start(page,{browser})
  expect(await page.evaluate(`(async()=>{
    await rewrite(input=>{
      const b=input.browser,t=input.tab,d=input.deviceCustody.scope
      input.browser={fence:b.fence,generation:b.generation,name:b.name}
      input.tab={expiresAt:t.expiresAt,purpose:t.purpose,fence:t.fence,generation:t.generation,name:t.name}
      input.deviceCustody={scope:input.deviceCustody.owner==='tab'?{expiresAt:d.expiresAt,purpose:d.purpose,fence:d.fence,generation:d.generation,name:d.name}:
        {fence:d.fence,generation:d.generation,name:d.name},owner:input.deviceCustody.owner}
    })
    const verified=Ordinary.readPersistentAdmissionProof(JSON.stringify(v2));verified.admission.secret.fill(0)
    await check();return true
  })()`)).toBe(true)
})
for(const v1First of [false,true])test(`holds v1/v2 historical browser logical-slot aliases, v1First=${v1First}`,async({page})=>{
  await start(page,{browser:true})
  expect(await page.evaluate(`(async()=>{
    await pair((b,t)=>{
      b.remove(v2name);const order=${v1First}?[original,v2]:[v2,original]
      for(const proof of order)b.set(Ordinary.persistentProofName(proof.binding),JSON.stringify(proof))
      // Remove selected tab rows so this specifically exercises browser slots.
      t.remove(v2tabName);t.remove(prefix+Ordinary.TAB_ADMISSION_PREFIX+id)
    });return outcome(check)
  })()`)).toBe('OrdinaryStateHold')
})

test('v1 adapter cannot reopen or forget v2 browser-device custody',async({page})=>{
  await start(page,{browser:true})
  expect(await page.evaluate(`(async()=>{
    const before=await records(),opened=await outcome(open),forgotten=await outcome(()=>oldMember.forget())
    return [opened,forgotten,JSON.stringify(before)===JSON.stringify(await records())]
  })()`)).toEqual(['OrdinaryStateHold','OrdinaryStateHold',true])
})

for(const browser of [false,true])test(`recomputed proof cannot change captured native room fence, browser=${browser}`,async({page})=>{
  await start(page,{browser})
  expect(await page.evaluate(`(async()=>{
    await rewrite(input=>{input.deviceCustody.scope.fence++})
    return outcome(check)
  })()`)).toBe('OrdinaryStateHold')
})
