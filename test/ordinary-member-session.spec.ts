import { build } from 'esbuild'
import { expect, test, type Page } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'
import type { Event } from 'nostr-tools/pure'
import { encodeEpochGrant } from '../src/epoch.js'
import { setup } from './ordinary-bootstrap.setup.js'
const ORIGIN = 'https://ordinary-member-session.kithmoot.test'
let bundle = ''
test.beforeAll(async () => { bundle = (await build({ entryPoints: [fileURLToPath(new URL('./ordinary-bootstrap.browser-entry.ts', import.meta.url))],
  bundle: true, format: 'iife', globalName: 'Ordinary', platform: 'browser', write: false, target: 'es2022' })).outputFiles[0]!.text })
test.beforeEach(async ({ context, page }) => { await context.route(ORIGIN + '/**', route => route.fulfill({ contentType: 'text/html',
  body: `<script>${bundle.replace(/<\/script/gi, '<\\/script')}</script>` })); await page.goto(ORIGIN) })
const controls = `async()=>{
 const material=await bootstrap.bootstrap(evidence);window.ownCredential=material.credential;Ordinary.wipeOrdinaryPersistentBootstrapResult(material);
 window.nativeHeld=0;window.dials=[];window.frames=[];window.sockets=[];window.randomness=[];window.grants=true;
 const request=navigator.locks.request.bind(navigator.locks);navigator.locks.request=(name,...args)=>{const callback=args.pop();return request(name,...args,async lock=>{
  if(name===Ordinary.ORDINARY_DATABASE+':write')nativeHeld++;try{return await callback(lock)}finally{if(name===Ordinary.ORDINARY_DATABASE+':write')nativeHeld--}})};
 const random=crypto.getRandomValues.bind(crypto);crypto.getRandomValues=(...args)=>{randomness.push(nativeHeld>0);return random(...args)};
 class Socket {
  readyState=0;onopen=null;onmessage=null;onclose=null;onerror=null;requests=new Map();
  constructor(url){this.url=url;sockets.push(this);dials.push(nativeHeld>0);queueMicrotask(()=>{if(this.readyState===3)return;this.readyState=1;this.onopen?.({type:'open'});
    if(window.challenge)this.message(['AUTH','member-auth'])})}
  message(frame){if(this.readyState!==3)this.onmessage?.({data:JSON.stringify(frame)})}
  send(raw){frames.push([JSON.parse(raw),nativeHeld>0]);const frame=JSON.parse(raw);if(frame[0]==='REQ')this.requests.set(frame[1],frame.slice(2));
   queueMicrotask(()=>{if(frame[0]==='REQ')this.message(['EOSE',frame[1]]);
    if(frame[0]==='AUTH')this.message(['OK',frame[1].id,true,'accepted']);
    if(frame[0]==='EVENT'){this.message(['OK',frame[1].id,true,'accepted']);
     if(frame[1].kind===20468&&grants){const grant=Ordinary.encodeEpochGrant({roomId,authoritySk:inviterSk,device:frame[1].pubkey,request:frame[1].id,
      epoch:{epoch:0,secret},credential:ownCredential,removed:[],now:Math.floor(Date.now()/1000)});
      for(const socket of sockets)for(const[id,filters]of socket.requests)if(filters.some(f=>f.kinds?.includes(grant.kind)))socket.message(['EVENT',id,grant])}
     else for(const socket of sockets)for(const[id,filters]of socket.requests)if(filters.some(f=>f.kinds?.includes(frame[1].kind)))socket.message(['EVENT',id,frame[1]])}})
  }
  close(){if(this.readyState===3)return;this.readyState=3;this.onclose?.({type:'close'})}
 }
 window.sessionSelected=true;
 window.sessionOptions={relays:window.memberRelayList??['wss://first.example/','wss://second.example/'],profile:'direct',websocketImplementation:Socket,live:()=>guard()&&sessionSelected,epochRequestTimeoutMs:1000};
 if(!window.deferMemberCreation)window.member=await bootstrap.openMemberSession(sessionOptions);
 window.join=()=>{window.joinState='pending';window.joining=member.join().then(()=>joinState='ok',error=>joinState=error.name);return joining};
}`
async function start(page: Page, visitor = true) { await page.evaluate(`(${setup})(${JSON.stringify({ visitor, noRelays: true })})`); await page.evaluate(`(${controls})()`) }
test('genuine member RoomSession completes a fresh sealed root round trip and guarded chat', async ({ page }) => {
  await start(page); await page.evaluate('join()'); expect(await page.evaluate('joinState')).toBe('ok')
  await page.evaluate('member.send("native member chat")')
  expect(await page.evaluate(`(async()=>{const messages=await member.messages();return[member.roomId===roomId,member.participant===participant,
    messages.some(m=>m.text==='native member chat'),dials.every(Boolean),frames.every(row=>row[1]),randomness.every(Boolean)]})()`)).toEqual([true, true, true, true, true, true])
  await page.evaluate('member.close()')
  expect(await page.evaluate('sockets.every(socket=>socket.readyState===3)')).toBe(true)
})
test('named channels and prepared sends expose no raw session, keys or generic executor', async ({ page }) => {
  await start(page); await page.evaluate('join()')
  expect(await page.evaluate(`(async()=>{const channel=await member.channel('boards'),prepared=await channel.prepare('bound board message');await prepared.publish();
    const names=Reflect.ownKeys(member);const result=[(await channel.messages()).some(m=>m.text==='bound board message'),
    ['run','check','session','protocol','currentEpoch','epochKeys','rekey','assignments','issueDeviceCredential'].every(n=>!names.includes(n)),
    Reflect.ownKeys(prepared).join(',')];await member.close();return result})()`)).toEqual([true, true, 'publish'])
})
test('silence and EOSE cannot release the genuine member session', async ({ page }) => {
  await start(page); await page.evaluate('grants=false;join();undefined'); await page.evaluate('joining')
  expect(await page.evaluate('joinState')).not.toBe('ok')
  expect(await page.evaluate('frames.every(row=>row[0][0]!=="EVENT"||row[0][1].kind===20468)')).toBe(true)
  await page.evaluate('member.close()')
})
test('a concurrent second member factory is refused before reading caller accessors', async ({ page }) => {
  await start(page)
  expect(await page.evaluate(`(async()=>{let called=0,error;const input={...sessionOptions};Object.defineProperty(input,'live',{get(){called++;return guard}});
    try{await bootstrap.openMemberSession(input)}catch(e){error=e.name};await member.close();return[error,called]})()`)).toEqual(['OrdinaryStateHold', 0])
})
for (const fault of ['selection','session-selection','browser-close','tab-close','bootstrap-close','same-byte-revision']) test(`${fault} revokes actual session chat before entropy or a late write`, async ({ page }) => {
  await start(page); await page.evaluate('join()')
  expect(await page.evaluate(`(async()=>{let before=randomness.length,frameCount=frames.length,closing;
    if('${fault}'==='selection')current={...current,keep:false};if('${fault}'==='browser-close')closing=browserOwner.close();
    if('${fault}'==='session-selection')sessionSelected=false;
    if('${fault}'==='tab-close')closing=tabOwner.close();if('${fault}'==='bootstrap-close')closing=bootstrap.close();
    if('${fault}'==='same-byte-revision'){const s=await scopes();await browserOwner.mutateMigrated(s.b,guard,()=>{});before=randomness.length;frameCount=frames.length}
    let error;try{await member.send('must stay private')}catch(e){error=e.name};await member.close();await closing;
    return[error,randomness.length===before,frames.length===frameCount,sockets.every(socket=>socket.readyState===3)]})()`)).toEqual(['OrdinaryStateHold', true, true, true])
})
test('session-only selection loss refuses retained message disclosure and performs terminal cleanup', async ({ page }) => {
  await start(page); await page.evaluate('join()'); await page.evaluate('member.send("already private")')
  expect(await page.evaluate(`(async()=>{sessionSelected=false;let error;try{await member.messages()}catch(e){error=e.name};await member.close();
    return[error,sockets.every(socket=>socket.readyState===3)]})()`)).toEqual(['OrdinaryStateHold', true])
})
test('carrier fatal ingress closes its owned session and permits reborrow only after joined cleanup', async ({ page }) => {
  await start(page); await page.evaluate('join()')
  await page.evaluate('sockets[0].onmessage({data:"{"});undefined')
  await page.waitForFunction('sockets.every(socket=>socket.readyState===3)')
  expect(await page.evaluate(`(async()=>{const before=randomness.length;let error;try{await member.send('closed carrier')}catch(e){error=e.name};
    await member.close();const held=randomness.length===before;const replacement=await bootstrap.openMemberSession(sessionOptions);await replacement.close();return[error,held]})()`))
    .toEqual(['OrdinaryStateHold', true])
})
test('credential threshold is rechecked after the carrier native read waits', async ({ page }) => {
  await page.evaluate(`(${setup})({visitor:true,noRelays:true})`); await page.evaluate('window.deferMemberCreation=true'); await page.evaluate(`(${controls})()`)
  expect(await page.evaluate(`(async()=>{const original=Ordinary.OrdinaryStateOwner.readPairMigrated,clock=Date.now;
    const openCarrier=Ordinary.OrdinaryRelayCarrier.open;let carrierOpening=false,crossed=false;
    Ordinary.OrdinaryRelayCarrier.open=async input=>{carrierOpening=true;return openCarrier.call(Ordinary.OrdinaryRelayCarrier,input)};
    Ordinary.OrdinaryStateOwner.readPairMigrated=async input=>{if(carrierOpening&&!crossed){crossed=true;await Promise.resolve();Date.now=()=>credentialExpiresAt*1000-599000};
      return original.call(Ordinary.OrdinaryStateOwner,input)};
    let error;try{await bootstrap.openMemberSession(sessionOptions)}catch(e){error=e.name}finally{Ordinary.OrdinaryStateOwner.readPairMigrated=original;Ordinary.OrdinaryRelayCarrier.open=openCarrier;Date.now=clock};
    return[error,crossed,dials.length,randomness.length]})()`)).toEqual(['OrdinaryStateHold', true, 0, 0])
})
for (const relays of [['wss://unselected.example/'], [{ url: 'wss://signed.example/', read: true, write: false }]]) {
  test(`signed fixed relay list refuses destination or permission substitution ${JSON.stringify(relays)}`, async ({ page }) => {
    await page.evaluate(`(${setup})({visitor:true})`); await page.evaluate('window.deferMemberCreation=true'); await page.evaluate(`(${controls})()`)
    expect(await page.evaluate(`bootstrap.openMemberSession({...sessionOptions,relays:${JSON.stringify(relays)}}).then(()=>undefined,e=>[e.name,dials.length,randomness.length])`))
      .toEqual(['OrdinaryStateHold', 0, 0])
  })
}
test('normalised exact signed relay list completes the real session', async ({ page }) => {
  await page.evaluate(`(${setup})({visitor:true})`); await page.evaluate('window.memberRelayList=[" wss://SIGNED.example "]'); await page.evaluate(`(${controls})()`)
  await page.evaluate('join()'); expect(await page.evaluate('[joinState,dials.length]')).toEqual(['ok', 1]); await page.evaluate('member.close()')
})
for (const fixed of [false, true]) test(`unverified circle mark refuses before dial even with signed destinations=${fixed}`, async ({ page }) => {
  await page.evaluate(`(${setup})(${JSON.stringify({visitor:true,noRelays:!fixed})})`); await page.evaluate('window.deferMemberCreation=true'); await page.evaluate(`(${controls})()`)
  expect(await page.evaluate(`bootstrap.openMemberSession({...sessionOptions,relays:[{url:'${fixed ? 'wss://signed.example/' : 'wss://first.example/'}',read:true,write:true,circle:true}]}).then(()=>undefined,e=>[e.name,dials.length,randomness.length])`))
    .toEqual(['OrdinaryStateHold', 0, 0])
})
test('accessor-backed chat and descriptor fields are refused without invoking caller code', async ({ page }) => {
  await start(page); await page.evaluate('join()')
  expect(await page.evaluate(`(async()=>{let called=0,errors=0;const options={};Object.defineProperty(options,'replyTo',{enumerable:true,get(){called++;return undefined}});
    const config={};Object.defineProperty(config,'forwarders',{enumerable:true,get(){called++;return []}});
    try{await member.send('held',options)}catch{errors++};try{await member.publishDescriptor(config)}catch{errors++};await member.close();return[called,errors]})()`)).toEqual([0, 2])
})
test('terminal close removes the one-session latch and permits a fresh owned instance', async ({ page }) => {
  await start(page); await page.evaluate('member.close()')
  expect(await page.evaluate(`(async()=>{const replacement=await bootstrap.openMemberSession(sessionOptions);const result=[replacement!==member,
    replacement.roomId===member.roomId,typeof bootstrap.borrowProtocolExecution];await replacement.close();return result})()`)).toEqual([true, true, 'undefined'])
})
test('selection getter re-entry cannot start a second constructor before the factory latch', async ({ page }) => {
  await start(page); await page.evaluate('member.close()')
  expect(await page.evaluate(`(async()=>{let reentered=false,error;Object.defineProperty(current,'keep',{get(){if(!reentered){reentered=true;
    try{bootstrap.openMemberSession(sessionOptions)}catch(e){error=e.name}}return keep}});
    const replacement=await bootstrap.openMemberSession(sessionOptions);await replacement.close();return[reentered,error]})()`)).toEqual([true, 'OrdinaryStateHold'])
})
test('natural original credential expiry closes the genuine session and all idle sockets', async ({ page }) => {
  await page.clock.install(); await start(page); await page.evaluate('join()')
  await page.clock.fastForward(1800_001)
  expect(await page.evaluate('sockets.every(socket=>socket.readyState===3)')).toBe(true)
  expect(await page.evaluate(`member.send('expired').then(()=>undefined,e=>e.name)`)).toBe('OrdinaryStateHold')
  await page.evaluate('member.close()')
})
test('close during a fresh root wait joins cancellation and releases no roster or chat', async ({ page }) => {
  await start(page); await page.evaluate('grants=false;join();undefined')
  await page.waitForFunction('frames.some(row=>row[0][0]==="EVENT"&&row[0][1].kind===20468)')
  await page.evaluate('member.close()'); await page.evaluate('joining')
  expect(await page.evaluate('[joinState,frames.every(row=>row[0][0]!=="EVENT"||row[0][1].kind===20468),sockets.every(s=>s.readyState===3)]'))
    .toEqual(['OrdinaryStateHold', true, true])
})
for (const policy of [{ tier: 'ken', admitted: ['b'.repeat(64)] }, { tier: 'open', agents: 'owned-by-members' },
  { tier: 'open', members: ['b'.repeat(64)] }, { tier: 'open', members: ['b'.repeat(64)], quiet: true }]) {
  test(`unsupported retained policy ${JSON.stringify(policy)} refuses before any dial or entropy`, async ({ page }) => {
    await page.evaluate(`(${setup})(${JSON.stringify({ visitor: true, noRelays: true, policy })})`)
    await page.evaluate('window.deferMemberCreation=true'); await page.evaluate(`(${controls})()`)
    expect(await page.evaluate(`bootstrap.openMemberSession(sessionOptions).then(()=>undefined,e=>[e.name,dials.length,randomness.length])`))
      .toEqual(['OrdinaryStateHold', 0, 0])
  })
}
test('explicit default open policy retains the real sealed-root and chat path', async ({ page }) => {
  await page.evaluate(`(${setup})(${JSON.stringify({ visitor: true, noRelays: true, policy: { tier: 'open' } })})`)
  await page.evaluate(`(${controls})()`); await page.evaluate('join()'); await page.evaluate('member.send("explicit open")')
  expect(await page.evaluate('(async()=>[joinState,(await member.messages()).some(m=>m.text==="explicit open")])()')).toEqual(['ok', true])
  await page.evaluate('member.close()')
})
for (const remaining of [599, 600]) test(`retained lease with ${remaining} seconds is checked before constructing sockets`, async ({ page }) => {
  await page.clock.install(); await page.evaluate(`(${setup})({visitor:true,noRelays:true})`)
  await page.evaluate('window.deferMemberCreation=true'); await page.evaluate(`(${controls})()`)
  await page.clock.fastForward((1800 - remaining) * 1000)
  await page.clock.setFixedTime(new Date(await page.evaluate(`(credentialExpiresAt-${remaining})*1000`)))
  if (remaining < 600) {
    expect(await page.evaluate('bootstrap.openMemberSession(sessionOptions).then(()=>undefined,e=>[e.name,dials.length,randomness.length])'))
      .toEqual(['OrdinaryStateHold', 0, 0])
  } else {
    await page.evaluate('(async()=>{member=await bootstrap.openMemberSession(sessionOptions)})()')
    await page.evaluate('join()')
    expect(await page.evaluate('[member.roomId===roomId,dials.length>0]')).toEqual([true, true])
    await page.evaluate('member.close()')
  }
})
test('authentication array and grant mutation after invocation cannot change captured native consent', async ({ page }) => {
  await page.evaluate(`(${setup})({visitor:false,noRelays:true})`); await page.evaluate('window.deferMemberCreation=true;window.challenge=true')
  await page.evaluate(`(${controls})()`)
  await page.evaluate(`(async()=>{const grant={url:sessionOptions.relays[0],identity};const authentication=[grant];
    const pending=bootstrap.openMemberSession({...sessionOptions,authentication});grant.url='wss://unselected.example/';
    grant.identity={pubkey:participant,signEvent(){throw Error('mutated')}};authentication.length=0;member=await pending})()`)
  await page.evaluate('join()')
  await page.waitForFunction('frames.some(row=>row[0][0]==="AUTH")')
  expect(await page.evaluate('[authSigns,frames.filter(row=>row[0][0]==="AUTH").every(row=>row[0][1].tags[0][1]===sessionOptions.relays[0]),frames.every(row=>row[1])]'))
    .toEqual([1, true, true])
  await page.evaluate('member.close()')
})
for (const lifetime of ['member', 'bootstrap', 'forget', 'browser', 'tab']) test(`${lifetime} close joins an unabortable native account AUTH without a late response`, async ({ page }) => {
  await page.evaluate(`(${setup})({visitor:false,noRelays:true})`); await page.evaluate('window.deferMemberCreation=true;window.challenge=true')
  await page.evaluate(`(${controls})()`)
  await page.evaluate(`(async()=>{window.authPending=false;window.authHook=event=>{authPending=true;return new Promise(resolve=>window.releaseAuth=()=>resolve(authSign(event)))};
    member=await bootstrap.openMemberSession({...sessionOptions,authentication:[{url:sessionOptions.relays[0],identity}]});join();undefined})()`)
  await page.waitForFunction('authPending')
  await page.evaluate(`window.closeState='pending';window.closing=${lifetime === 'forget' ? 'bootstrap.forget()' : (lifetime === 'member' || lifetime === 'bootstrap' ? lifetime : lifetime + 'Owner') + '.close()'}.then(()=>closeState='ok');undefined`)
  expect(await page.evaluate('closeState')).toBe('pending')
  await page.evaluate('releaseAuth();undefined'); await page.evaluate('closing'); await page.evaluate('joining')
  expect(await page.evaluate('[closeState,joinState,frames.every(row=>row[0][0]!=="AUTH"),sockets.every(socket=>socket.readyState===3)]'))
    .toEqual(['ok', 'OrdinaryStateHold', true, true])
  await page.evaluate('member.close()')
})
test('the first-credential lease refuses renewal without issuing or retaining a replacement', async ({ page }) => {
  await page.clock.install(); await start(page, false); await page.evaluate('join()')
  await page.clock.fastForward(901_000)
  expect(await page.evaluate(`(async()=>{const current=await bootstrap.load();try{return[signCalls,current.credential.id===ownCredential.id]}
    finally{Ordinary.wipeOrdinaryPersistentBootstrapResult(current)}})()`)).toEqual([1, true])
  await page.evaluate('member.send("old credential remains usable after refused renewal")')
  expect(await page.evaluate('(async()=>[(await member.messages()).some(m=>m.text==="old credential remains usable after refused renewal"),sockets.some(socket=>socket.readyState===1)])()'))
    .toEqual([true, true])
  await page.evaluate('member.close()')
})
for (const change of ['catch-up', 'closed', 'removed', 'readable']) test(`actual signed ${change} rekey respects the bounded native session lifecycle`, async ({ page }) => {
  await start(page); await page.evaluate('join()')
  if (change === 'readable') await page.evaluate('(async()=>{window.oldPrepared=await member.prepare("prepared under the old epoch")})()')
  await page.evaluate(`(()=>{const next={epoch:1,secret:new Uint8Array(32).fill(41)};
    const event=Ordinary.encodeRekeyEvent({roomId,authoritySk:inviterSk,current:Ordinary.deriveEpoch({epoch:0,secret}),next,
      recipients:'${change}'==='readable'?[{device:member.device,credential:ownCredential}]:[],removed:'${change}'==='removed'?[participant]:[],
      ...('${change}'==='closed'?{closed:true}:{}),now:Math.floor(Date.now()/1000)});
    window.rekeyBefore=randomness.length;window.rekeyFrames=frames.length;
    for(const socket of sockets)for(const[id,filters]of socket.requests)if(filters.some(f=>f.kinds?.includes(event.kind)))socket.message(['EVENT',id,event])})()`)
  if (change === 'readable') {
    await page.waitForFunction('frames.slice(rekeyFrames).some(row=>row[0][0]==="EVENT"&&row[0][1].kind===20461&&row[0][1].tags.some(t=>t[0]==="d"&&t[1]===Ordinary.deriveEpoch({epoch:1,secret:new Uint8Array(32).fill(41)}).id))')
    expect(await page.evaluate('oldPrepared.publish().then(()=>"ok",e=>e.message)')).toContain('changed its key')
    await page.evaluate('member.send("after readable rekey")')
    expect(await page.evaluate('(async()=>[sockets.some(s=>s.readyState===1),(await member.messages()).some(m=>m.text==="after readable rekey"),frames.every(row=>row[1])])()'))
      .toEqual([true, true, true])
  } else {
    await page.waitForFunction('sockets.every(socket=>socket.readyState===3)')
    expect(await page.evaluate(`(async()=>{let error;try{await member.send('refused epoch')}catch(e){error=e.name};await member.close();
      return[error,randomness.length===rekeyBefore,frames.slice(rekeyFrames).every(row=>row[0][0]!=='EVENT')]})()`))
      .toEqual(['OrdinaryStateHold', true, true])
  }
  await page.evaluate('member.close()')
})
for (const field of ['index', 'url', 'identity']) test(`authentication ${field} accessor refuses without invoking caller code`, async ({ page }) => {
  await page.evaluate(`(${setup})({visitor:true,noRelays:true})`); await page.evaluate('window.deferMemberCreation=true'); await page.evaluate(`(${controls})()`)
  expect(await page.evaluate(`(async()=>{let called=0;const grant={url:sessionOptions.relays[0],identity};const authentication=[grant];
    if('${field}'==='index')Object.defineProperty(authentication,'0',{get(){called++;return grant}});
    else Object.defineProperty(grant,'${field}',{get(){called++;return undefined}});
    let error;try{await bootstrap.openMemberSession({...sessionOptions,authentication})}catch(e){error=e.name};return[error,called,dials.length,randomness.length]})()`))
    .toEqual(['OrdinaryStateHold', 0, 0, 0])
})
test('real loopback WebSockets carry native member admission, sealed root and chat', async ({ page }) => {
  const http = createServer((_request, response) => { response.setHeader('content-type', 'text/html'); response.end(`<script>${bundle.replace(/<\/script/gi, '<\\/script')}</script>`) })
  const relay = new WebSocketServer({ server: http }), received: unknown[][] = []
  const subscriptions = new Map<object, Map<string, { kinds?: number[] }[]>>()
  let credential: Event, room: string
  const secret = new Uint8Array(32).fill(31), authoritySk = new Uint8Array(32); authoritySk[31] = 7
  await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(0, '127.0.0.1', resolve) })
  const address = http.address(); if (!address || typeof address === 'string') throw Error('no loopback port')
  relay.on('connection', socket => {
    const requests = new Map<string, { kinds?: number[] }[]>(); subscriptions.set(socket, requests)
    socket.on('close', () => subscriptions.delete(socket))
    socket.on('message', bytes => {
      const frame = JSON.parse(bytes.toString()); received.push(frame)
      if (frame[0] === 'REQ') { requests.set(frame[1], frame.slice(2)); socket.send(JSON.stringify(['EOSE', frame[1]])) }
      if (frame[0] === 'CLOSE') requests.delete(frame[1])
      if (frame[0] !== 'EVENT') return
      const event = frame[1] as Event
      socket.send(JSON.stringify(['OK', event.id, true, 'accepted']))
      const delivered = event.kind === 20468 ? encodeEpochGrant({ roomId: room, authoritySk, device: event.pubkey, request: event.id,
        epoch: { epoch: 0, secret }, credential, removed: [], now: Math.floor(Date.now() / 1000) }) : event
      for (const peer of relay.clients) for (const [id, filters] of subscriptions.get(peer) ?? []) {
        if (filters.some(filter => filter.kinds?.includes(delivered.kind))) peer.send(JSON.stringify(['EVENT', id, delivered]))
      }
    })
  })
  try {
    await page.goto(`http://127.0.0.1:${address.port}/ui`); await page.evaluate(`(${setup})({visitor:true,noRelays:true})`)
    await page.evaluate('window.deferMemberCreation=true'); await page.evaluate(`(${controls})()`)
    credential = await page.evaluate('ownCredential'); room = await page.evaluate('roomId')
    await page.evaluate(`(async()=>{const NativeSocket=WebSocket;class BoundSocket extends NativeSocket {
      constructor(url,protocols){dials.push(nativeHeld>0);super(url,protocols);sockets.push(this)}
      send(raw){frames.push([JSON.parse(raw),nativeHeld>0]);super.send(raw)}
    };member=await bootstrap.openMemberSession({...sessionOptions,relays:['ws://127.0.0.1:${address.port}/relay'],websocketImplementation:BoundSocket})})()`)
    await page.evaluate('join()'); await page.evaluate('member.send("actual loopback member chat")')
    expect(await page.evaluate('(async()=>[joinState,(await member.messages()).some(m=>m.text==="actual loopback member chat"),dials.length>0,dials.every(Boolean),frames.every(row=>row[1])])()'))
      .toEqual(['ok', true, true, true, true])
    expect(received.some(frame => frame[0] === 'EVENT' && (frame[1] as Event).kind === 20468)).toBe(true)
    await page.evaluate('member.close()')
  } finally {
    for (const socket of relay.clients) socket.terminate()
    await new Promise<void>(resolve => relay.close(() => resolve())); await new Promise<void>(resolve => http.close(() => resolve()))
    authoritySk.fill(0); secret.fill(0)
  }
})
