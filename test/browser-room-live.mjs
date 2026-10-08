// Visible room activation against a real claimed Bothy, pinned Link WASM,
// local public relay and the actual built PWA. No production account data.
import {chromium} from '@playwright/test'
import {finalizeEvent,getPublicKey,generateSecretKey} from 'nostr-tools/pure'
import {encodeJoinUrl,generateRoomSecret,deriveRoom,deriveChannel,createRoomInvitation,encodeRoomLink,encodePersistentInvitation,deriveInvitationId} from '@forgesworn/fold-kit'
import WebSocket from 'ws'
import {createHash} from 'node:crypto'
import {createServer} from 'node:http'
import {readFileSync,existsSync,mkdtempSync,cpSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {resolve,extname} from 'node:path'
import assert from 'node:assert/strict'
import {installRoomFaults,armRoomFault,waitRoomFault} from './browser-room-faults.mjs'
import {expiryBundle,grantRows,shortenGrants} from './browser-room-expiry.mjs'

const recovery=process.env.ROOM_RECOVERY_MATRIX==='1', interruptions=[]
const persistent=process.env.ROOM_PERSISTENT_INVITATION==='1'
const expiry=process.env.ROOM_EXPIRY==='1', signedGrants=new Map()
const fixtureBundle=expiry ? await expiryBundle() : undefined

const control=process.env.LINK_BOTHY_CONTROL, linkRelay=process.env.LINK_TEST_RELAY
if(!control || new URL(control).hostname!=='127.0.0.1' || !linkRelay?.startsWith('wss://')) throw new Error('Set loopback Bothy control and WebPKI Link relay.')
const root=mkdtempSync(resolve(tmpdir(),'kithmoot-room-'))
cpSync(resolve('app/dist'),root,{recursive:true})
const server=createServer((req,res)=>{
  const pathname=new URL(req.url,'http://localhost').pathname
  if(fixtureBundle && pathname==='/j/__expiry.html'){res.setHeader('Content-Type','text/html');res.end('<script src="./__expiry.js"></script>');return}
  if(fixtureBundle && pathname==='/j/__expiry.js'){res.setHeader('Content-Type','text/javascript');res.end(fixtureBundle);return}
  const file=resolve(root,pathname.replace(/^\/j\//,'') || 'index.html')
  if(!file.startsWith(root+'/') || !existsSync(file)){res.writeHead(404);res.end();return}
  const mime={'.html':'text/html','.js':'text/javascript','.wasm':'application/wasm','.css':'text/css','.json':'application/json','.webmanifest':'application/manifest+json','.svg':'image/svg+xml','.png':'image/png'}
  res.setHeader('Content-Type',mime[extname(file)]??'application/octet-stream');res.end(readFileSync(file))
})
await new Promise(r=>server.listen(0,'127.0.0.1',r))
const app=`http://127.0.0.1:${server.address().port}/j/`, publicRelay=process.env.LINK_PUBLIC_RELAY ?? 'ws://127.0.0.1:7777'
if(new URL(publicRelay).hostname!=='127.0.0.1' || new URL(publicRelay).protocol!=='ws:')throw new Error('Public fixture relay must be loopback.')
const launchOptions={args:[`--host-resolver-rules=MAP ${new URL(linkRelay).hostname} 127.0.0.1`]}
const browser=await chromium.launch(launchOptions)
const ownerProfile=recovery ? mkdtempSync(resolve(tmpdir(),'kithmoot-room-owner-')) : undefined
const ownerKey=new Uint8Array(createHash('sha256').update('kithmoot-g5-fixture-signer-v2:alice').digest()), guestKey=generateSecretKey()
const secret=generateRoomSecret(), room=deriveRoom(secret), invitation=persistent ? createRoomInvitation(true) : undefined
const url=invitation ? encodeRoomLink(app,{invitation:invitation.invitation,relays:[publicRelay],iceUrls:[]}) : encodeJoinUrl(app,secret,[publicRelay])
const wireScopes=new Set([room.roomId,deriveChannel(room.roomId,room.roomKey,'control').id])
if(invitation)wireScopes.add(deriveInvitationId(invitation.invitation))
const contexts=[], pages=[], errors=[], counters={before:0,after:0};let activated=false, monitorGuestOnly=false
const ownerPages=new Set();let ownerHeld=false, heldOwnerFrames=0
const attach=page=>{
  pages.push(page);page.on('pageerror',e=>errors.push(e.message))
  page.on('websocket',socket=>socket.on('framesent',frame=>{
    if(typeof frame.payload!=='string')return
    try{const f=JSON.parse(frame.payload), scoped=f[0]==='REQ'?f.slice(2).some(x=>x['#d']?.some(d=>wireScopes.has(d))):f[0]==='EVENT'&&f[1]?.tags?.some(t=>t[0]==='d'&&wireScopes.has(t[1]));if(scoped&&(!monitorGuestOnly||page.context()===contexts[1]))counters[activated?'after':'before']++;if(scoped&&ownerHeld&&ownerPages.has(page))heldOwnerFrames++}catch{}
  }))
}
const createContext=async key=>{
  const options={viewport:{width:390,height:844}}
  const context=key===ownerKey && ownerProfile
    ? await chromium.launchPersistentContext(ownerProfile,{...launchOptions,...options})
    : await browser.newContext(options)
  contexts.push(context)
  if(recovery && key===ownerKey)await installRoomFaults(context)
  await context.exposeFunction('fixturePublicKey',()=>getPublicKey(key));await context.exposeFunction('fixtureSign',e=>{
    const event=finalizeEvent(e,key)
    if(key===ownerKey && e.kind===24242 && e.tags.some(t=>t[0]==='status'&&t[1]==='active'))signedGrants.set(e.tags.find(t=>t[0]==='grant')[1],event)
    return event
  })
  await context.addInitScript(()=>{window.nostr={getPublicKey:()=>window.fixturePublicKey(),signEvent:e=>window.fixtureSign(e)}})
  await context.addInitScript(({linkRelay,publicRelay})=>{
    const Native=window.WebSocket
    window.WebSocket=class extends Native{constructor(url,protocols){super(String(url)===linkRelay||String(url).startsWith(publicRelay)?url:publicRelay+'/auxiliary',protocols)}}
  },{linkRelay,publicRelay})
  return context
}
const setup=async key=>{
  const context=await createContext(key)
  const page=await context.newPage();attach(page)
  await page.goto(app+'?signin=nostr');await page.getByRole('button',{name:/Browser extension/}).click()
  await page.locator('#openAppSettings').click();if(!await page.locator('#bothySettingsOpen').isVisible())await page.locator('#appConnections > summary').click()
  await page.locator('#bothySettingsOpen').click();await page.locator('#bothyRelays').fill(linkRelay)
  await page.getByRole('button',{name:'Connect or resume',exact:true}).click()
  await page.getByText('Ready to pair. Paste a current code from your Bothy.',{exact:true}).waitFor()
  const {uri}=await(await fetch(control+'/pairing',{method:'POST'})).json()
  await page.locator('#bothyCode').fill(uri);await page.getByRole('button',{name:'Pair Bothy',exact:true}).click()
  await page.locator('#bothyStatus').filter({hasText:'Bothy paired and saved'}).waitFor({timeout:90000})
  await page.locator('#bothyClose').click()
  if(invitation && key===ownerKey)await page.evaluate(({id,roomSecret,inviterSk})=>{
    localStorage.setItem('kithmoot.invitation-owner.v1.'+id,JSON.stringify({roomSecret,inviterSk,createdAt:Math.floor(Date.now()/1000)}))
  },{id:deriveInvitationId(invitation.invitation),roomSecret:Buffer.from(secret).toString('hex'),inviterSk:Buffer.from(invitation.inviterSk).toString('hex')})
  // Navigation stops the endpoint; the room panel explicitly resumes it.
  await page.goto(url);await page.reload();await page.locator('#join').click();await page.locator('#roomArea').waitFor({state:'visible',timeout:45000})
  return {context,page}
}
const openRoom=async page=>{await page.locator('#roomMenu').click();await page.locator('#roomBothySettings').click();await page.locator('#bothyRoomRoute option').first().waitFor({state:'attached',timeout:15000})}
const openRecovery=async page=>{
  await page.getByRole('button',{name:'Recover Bothy room access',exact:true}).click()
  await page.locator('#bothyRoomRoute option').first().waitFor({state:'attached'})
}
const interrupted=async (owner,button,pending,settled)=>{
  const snapshots=[]
  for(const [phase,point] of [[pending,'before-publish'],[pending,'lost-first-ok'],[settled,'after-ack']]){
    await armRoomFault(owner.page,phase,point)
    await owner.page.locator(button).click()
    snapshots.push(await waitRoomFault(owner.page));ownerHeld=true
    if(expiry && point==='lost-first-ok'){
      const consent=snapshots.at(-1), statement=pending==='withdrawing'?'revoked':'active'
      const first=consent.grants[0][statement], rows=await grantRows(control,consent.scopes,consent.account)
      assert(rows.some(g=>g.id===first.tags.find(t=>t[0]==='grant')[1] && g.created_at===first.created_at && g.status===(statement==='revoked'?'revoked':'active')),
        'lost acknowledgement must correspond to an actual committed server row')
    }
    await owner.context.close()
    owner.context=await createContext(ownerKey)
    owner.page=await owner.context.newPage();ownerPages.add(owner.page);attach(owner.page)
    owner.other=await owner.context.newPage();ownerPages.add(owner.other);attach(owner.other);await owner.other.goto(app)
    await owner.page.goto(url);await openRecovery(owner.page)
    await owner.page.locator('#bothyRoomStatus').filter({hasText:`Saved state: ${pending}.`}).waitFor()
    interruptions.push(`${pending}:${point}`)
    console.error('recovered durable transition',pending,point)
  }
  for(const snapshot of snapshots.slice(1))assert.deepEqual(snapshots[0].grants,snapshot.grants,'resume must replay identical signed statements and grant IDs')
  assert.equal(heldOwnerFrames,0,'pending consent must never reopen public room sockets')
}
try{
  if(invitation){
    const event=encodePersistentInvitation({...invitation,roomSecret:secret,now:Math.floor(Date.now()/1000),relays:[new URL(publicRelay).href]})
    await new Promise((resolve,reject)=>{
      const socket=new WebSocket(publicRelay), timer=setTimeout(()=>{socket.close();reject(new Error('Fixture invitation publication timed out'))},10000)
      socket.on('error',error=>{clearTimeout(timer);reject(error)})
      socket.on('open',()=>socket.send(JSON.stringify(['EVENT',event])))
      socket.on('message',bytes=>{const frame=JSON.parse(String(bytes));if(frame[0]==='OK'&&frame[1]===event.id){clearTimeout(timer);socket.close();frame[2]?resolve():reject(new Error('Fixture invitation refused'))}})
    })
  }
  const owner=await setup(ownerKey);console.error('owner paired and public room open')
  ownerPages.add(owner.page)
  const guest=await setup(guestKey);console.error('guest paired and public room open')
  await owner.page.locator('#chatInput').fill('Public positive control');await owner.page.locator('#chatInput').press('Enter')
  await guest.page.locator('#chatLog').filter({hasText:'Public positive control'}).waitFor()
  assert(counters.before>0)
  // A second tab watches the room from its saved room list.
  const other=await owner.context.newPage();owner.other=other;ownerPages.add(other);attach(other);await other.goto(app)
  await owner.page.evaluate(async()=>{await navigator.serviceWorker.ready})
  await guest.page.evaluate(async()=>{await navigator.serviceWorker.ready})
  const outdated=await owner.context.newPage();attach(outdated)
  await outdated.addInitScript(()=>{const add=navigator.serviceWorker.addEventListener.bind(navigator.serviceWorker);navigator.serviceWorker.addEventListener=(type,...rest)=>{if(type!=='message')add(type,...rest)}})
  await outdated.goto(app)
  await openRoom(owner.page);await owner.page.locator('#bothyRoomKeeper').check()
  await owner.page.locator('#bothyRoomActivate').click()
  await owner.page.locator('#bothyRoomStatus').filter({hasText:'Update, wake or close the other KithMoot tabs'}).waitFor({timeout:20000})
  await outdated.close()
  console.error('unresponsive app tab refused activation')
  // The refused attempt already saved installing intent; recover that exact plan.
  if(recovery)await interrupted(owner,'#bothyRoomActivate','installing','active')
  await owner.page.locator('#bothyRoomActivate').click()
  await owner.page.locator('#bothyRoomStatus').filter({hasText:'This room now uses Bothy'}).waitFor({timeout:120000})
  console.error('owner activated')
  await openRoom(guest.page);await guest.page.locator('#bothyRoomActivate').click()
  await guest.page.locator('#bothyRoomStatus').filter({hasText:'This room now uses Bothy'}).waitFor({timeout:120000})
  console.error('guest activated')
  activated=true
  for(const page of [owner.page,guest.page])await page.locator('#bothyRoomClose').click()
  await owner.page.locator('#chatInput').fill('Bothy private round trip');await owner.page.locator('#chatInput').press('Enter')
  await guest.page.locator('#chatLog').filter({hasText:'Bothy private round trip'}).waitFor({timeout:45000})
  assert.equal(counters.after,0)
  if(persistent){
    await guest.page.close();guest.page=await guest.context.newPage();attach(guest.page);await guest.page.goto(url)
    await owner.other.bringToFront();await owner.other.reload()
  } else await guest.page.reload()
  await guest.page.locator('#join').click();await guest.page.locator('#roomArea').waitFor({state:'visible',timeout:45000})
  assert.equal((await fetch(control+'/restart',{method:'POST'})).ok,true)
  await owner.page.locator('#chatInput').fill('After Bothy restart');await owner.page.locator('#chatInput').press('Enter')
  await guest.page.locator('#chatLog').filter({hasText:'After Bothy restart'}).waitFor({timeout:90000})
  console.error('reload and box restart round trip')
  const relayControl=process.env.LINK_RELAY_CONTROL
  if(!relayControl || new URL(relayControl).hostname!=='127.0.0.1')throw new Error('Set loopback LINK_RELAY_CONTROL for restart acceptance.')
  assert.equal((await fetch(relayControl+'/restart',{method:'POST'})).ok,true)
  await owner.page.locator('#chatInput').fill('After Link relay restart');await owner.page.locator('#chatInput').press('Enter')
  await guest.page.locator('#chatLog').filter({hasText:'After Link relay restart'}).waitFor({timeout:120000})
  console.error('Link relay restart round trip')
  await openRoom(owner.page)
  if(recovery)await interrupted(owner,'#bothyRoomRenew','renewing','active')
  await owner.page.locator('#bothyRoomRenew').click()
  await owner.page.locator('#bothyRoomStatus').filter({hasText:'Bothy confirmed renewed'}).waitFor({timeout:120000})
  await owner.page.locator('#bothyRoomClose').click()
  await guest.page.locator('#chatInput').fill('After renewal');await guest.page.locator('#chatInput').press('Enter')
  await owner.page.locator('#chatLog').filter({hasText:'After renewal'}).waitFor({timeout:60000})
  assert.equal(counters.after,0)
  console.error('renewal round trip')
  if(expiry){
    const issuer=getPublicKey(ownerKey), scopes=[...wireScopes]
    const original=await grantRows(control,scopes,issuer)
    assert.equal(original.length,signedGrants.size);assert(original.every(g=>g.effective))
    const expires=await shortenGrants({browser,app,control,linkRelay,ownerKey,grants:[...signedGrants.values()]})
    const shortened=await grantRows(control,scopes,issuer)
    assert.deepEqual(shortened.map(g=>g.id),original.map(g=>g.id))
    assert(shortened.every(g=>g.expires===expires && g.effective))
    await guest.page.reload();await guest.page.locator('#join').click()
    await guest.page.locator('#roomArea').waitFor({state:'visible',timeout:45000})
    await new Promise(r=>setTimeout(r,Math.max(0,(expires+1)*1000-Date.now())))
    const elapsed=await grantRows(control,scopes,issuer)
    assert(elapsed.every(g=>!g.effective));assert.equal(elapsed.length,original.length)
    await guest.page.locator('#chatInput').fill('Held after real grant expiry');await guest.page.locator('#chatInput').press('Enter')
    await guest.page.locator('#outbox').filter({hasText:'Held after real grant expiry'}).waitFor()
    await guest.page.locator('#outbox').getByRole('button',{name:'Retry',exact:true}).first().click()
    await guest.page.locator('#bothyRoomConnection').filter({hasText:'Relay refused this authentication key'}).waitFor({timeout:60000})
    assert.equal(counters.after,0)
    await openRoom(owner.page);await owner.page.locator('#bothyRoomRenew').click()
    await owner.page.locator('#bothyRoomStatus').filter({hasText:'Bothy confirmed renewed'}).waitFor({timeout:120000})
    await owner.page.locator('#bothyRoomClose').click()
    const renewed=await grantRows(control,scopes,issuer)
    assert.deepEqual(renewed.map(g=>g.id),original.map(g=>g.id));assert(renewed.every(g=>g.effective&&g.expires>expires))
    await guest.page.reload();await guest.page.locator('#join').click()
    await guest.page.locator('#roomArea').waitFor({state:'visible',timeout:45000})
    await owner.page.locator('#chatInput').fill('After expired grants renewed');await owner.page.locator('#chatInput').press('Enter')
    await guest.page.locator('#chatLog').filter({hasText:'After expired grants renewed'}).waitFor({timeout:60000})
    assert.equal(counters.after,0)
    console.error('real-clock grant expiry, refusal and same-ID renewal verified')
  }
  monitorGuestOnly=true
  await openRoom(owner.page)
  if(recovery)await interrupted(owner,'#bothyRoomWithdraw','withdrawing','retired')
  ownerHeld=false
  await owner.page.locator('#bothyRoomWithdraw').click()
  await owner.page.locator('#bothyRoomStatus').filter({hasText:'local room selection was withdrawn'}).waitFor({timeout:120000})
  if(expiry){
    const withdrawn=await grantRows(control,[...wireScopes],getPublicKey(ownerKey))
    assert.equal(withdrawn.length,signedGrants.size)
    assert(withdrawn.every(g=>g.status==='revoked'&&!g.active&&!g.effective&&g.expiration_high_water>=g.expires))
  }
  await guest.page.locator('#chatInput').fill('Refused after keeper withdrawal');await guest.page.locator('#chatInput').press('Enter')
  await guest.page.locator('#outbox').filter({hasText:'Refused after keeper withdrawal'}).waitFor()
  await guest.page.locator('#outbox').getByRole('button',{name:'Retry',exact:true}).first().click()
  await guest.page.locator('#bothyRoomConnection').filter({hasText:'Relay refused this authentication key'}).waitFor({timeout:60000})
  assert(await guest.page.locator('#outbox').getByText('Refused after keeper withdrawal',{exact:true}).isVisible())
  assert.equal(counters.after,0)
  assert.deepEqual(errors,[])
  await guest.page.screenshot({path:'/tmp/vennel-room-refused.png'})
  console.log(JSON.stringify({browser:browser.version(),platform:process.platform,arch:process.arch,appIndexSha256:createHash('sha256').update(readFileSync(resolve(root,'index.html'))).digest('hex'),visibleActivation:true,secondTab:true,oldTabRefusal:true,privateMessage:true,reloadResume:true,persistentInvitation:persistent,browserProcessRestart:recovery,boxRestart:true,linkRelayRestart:true,renewal:true,keeperWithdrawal:true,guestHeld:true,explicitGuestRefusal:true,realClockExpiry:expiry,serverGrantRowsVerified:expiry,publicRoomFrames:counters.after,heldOwnerFrames,interruptions,pageErrors:errors}))
}catch(error){
  for(let i=0;i<pages.length;i++){await pages[i].screenshot({path:`/tmp/vennel-room-failed-${i}.png`}).catch(()=>{});console.error('page',i,await pages[i].locator('#bothyRoomStatus').textContent().catch(()=>''),await pages[i].locator('#status').textContent().catch(()=>''),await pages[i].locator('#bothyRoomConnection').textContent().catch(()=>''))}
  console.error('page errors',errors);throw error
}finally{ownerKey.fill(0);guestKey.fill(0);invitation?.inviterSk.fill(0);for(const c of contexts)await c.close();await browser.close();await new Promise(r=>server.close(r));rmSync(root,{recursive:true,force:true});if(ownerProfile)rmSync(ownerProfile,{recursive:true,force:true})}
