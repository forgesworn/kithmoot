// Visible room activation against a real claimed Bothy, pinned Link WASM,
// local public relay and the actual built PWA. No production account data.
import {chromium} from '@playwright/test'
import {finalizeEvent,getPublicKey,generateSecretKey} from 'nostr-tools/pure'
import {encodeJoinUrl,generateRoomSecret,deriveRoom,deriveChannel} from '@forgesworn/fold-kit'
import {createHash} from 'node:crypto'
import {createServer} from 'node:http'
import {readFileSync,existsSync} from 'node:fs'
import {resolve,extname} from 'node:path'
import assert from 'node:assert/strict'

const control=process.env.LINK_BOTHY_CONTROL, linkRelay=process.env.LINK_TEST_RELAY
if(!control || new URL(control).hostname!=='127.0.0.1' || !linkRelay?.startsWith('wss://')) throw new Error('Set loopback Bothy control and WebPKI Link relay.')
const root=resolve('app/dist'), server=createServer((req,res)=>{
  const pathname=new URL(req.url,'http://localhost').pathname
  const file=resolve(root,pathname.replace(/^\/j\//,'') || 'index.html')
  if(!file.startsWith(root+'/') || !existsSync(file)){res.writeHead(404);res.end();return}
  const mime={'.html':'text/html','.js':'text/javascript','.wasm':'application/wasm','.css':'text/css','.json':'application/json','.webmanifest':'application/manifest+json','.svg':'image/svg+xml','.png':'image/png'}
  res.setHeader('Content-Type',mime[extname(file)]??'application/octet-stream');res.end(readFileSync(file))
})
await new Promise(r=>server.listen(0,'127.0.0.1',r))
const app=`http://127.0.0.1:${server.address().port}/j/`, publicRelay='ws://127.0.0.1:7777'
const browser=await chromium.launch({args:[`--host-resolver-rules=MAP ${new URL(linkRelay).hostname} 127.0.0.1`]})
const ownerKey=new Uint8Array(createHash('sha256').update('kithmoot-g5-fixture-signer-v2:alice').digest()), guestKey=generateSecretKey()
const secret=generateRoomSecret(), room=deriveRoom(secret), url=encodeJoinUrl(app,secret,[publicRelay])
const wireScopes=new Set([room.roomId,deriveChannel(room.roomId,room.roomKey,'control').id])
const contexts=[], pages=[], errors=[], counters={before:0,after:0};let activated=false, monitorGuestOnly=false
const attach=page=>{
  pages.push(page);page.on('pageerror',e=>errors.push(e.message))
  page.on('websocket',socket=>socket.on('framesent',frame=>{
    if(typeof frame.payload!=='string')return
    try{const f=JSON.parse(frame.payload), scoped=f[0]==='REQ'?f.slice(2).some(x=>x['#d']?.some(d=>wireScopes.has(d))):f[0]==='EVENT'&&f[1]?.tags?.some(t=>t[0]==='d'&&wireScopes.has(t[1]));if(scoped&&(!monitorGuestOnly||page===pages[1]))counters[activated?'after':'before']++}catch{}
  }))
}
const setup=async key=>{
  const context=await browser.newContext({viewport:{width:390,height:844}});contexts.push(context)
  await context.exposeFunction('fixturePublicKey',()=>getPublicKey(key));await context.exposeFunction('fixtureSign',e=>finalizeEvent(e,key))
  await context.addInitScript(()=>{window.nostr={getPublicKey:()=>window.fixturePublicKey(),signEvent:e=>window.fixtureSign(e)}})
  await context.addInitScript(({linkRelay,publicRelay})=>{
    const Native=window.WebSocket
    window.WebSocket=class extends Native{constructor(url,protocols){super(String(url)===linkRelay||String(url).startsWith(publicRelay)?url:publicRelay+'/auxiliary',protocols)}}
  },{linkRelay,publicRelay})
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
  // Navigation stops the endpoint; the room panel explicitly resumes it.
  await page.goto(url);await page.reload();await page.locator('#join').click();await page.locator('#roomArea').waitFor({state:'visible',timeout:45000})
  return {context,page}
}
const openRoom=async page=>{await page.locator('#roomMenu').click();await page.locator('#roomBothySettings').click();await page.locator('#bothyRoomRoute option').first().waitFor({state:'attached',timeout:15000})}
try{
  const owner=await setup(ownerKey);console.error('owner paired and public room open')
  const guest=await setup(guestKey);console.error('guest paired and public room open')
  await owner.page.locator('#chatInput').fill('Public positive control');await owner.page.locator('#chatInput').press('Enter')
  await guest.page.locator('#chatLog').filter({hasText:'Public positive control'}).waitFor()
  assert(counters.before>0)
  // A second tab watches the room from its saved room list.
  const other=await owner.context.newPage();attach(other);await other.goto(app)
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
  await guest.page.reload();await guest.page.locator('#join').click();await guest.page.locator('#roomArea').waitFor({state:'visible',timeout:45000})
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
  await openRoom(owner.page);await owner.page.locator('#bothyRoomRenew').click()
  await owner.page.locator('#bothyRoomStatus').filter({hasText:'Bothy confirmed renewed'}).waitFor({timeout:120000})
  await owner.page.locator('#bothyRoomClose').click()
  await guest.page.locator('#chatInput').fill('After renewal');await guest.page.locator('#chatInput').press('Enter')
  await owner.page.locator('#chatLog').filter({hasText:'After renewal'}).waitFor({timeout:60000})
  assert.equal(counters.after,0)
  console.error('renewal round trip')
  monitorGuestOnly=true
  await openRoom(owner.page);await owner.page.locator('#bothyRoomWithdraw').click()
  await owner.page.locator('#bothyRoomStatus').filter({hasText:'local room selection was withdrawn'}).waitFor({timeout:120000})
  await guest.page.locator('#chatInput').fill('Refused after keeper withdrawal');await guest.page.locator('#chatInput').press('Enter')
  await guest.page.locator('#outbox').filter({hasText:'Refused after keeper withdrawal'}).waitFor()
  await guest.page.locator('#outbox').getByRole('button',{name:'Retry',exact:true}).first().click()
  await guest.page.locator('#outbox .pendingStatus').filter({hasText:'Not sent'}).waitFor({timeout:60000})
  assert.equal(counters.after,0)
  assert.deepEqual(errors,[])
  await guest.page.screenshot({path:'/tmp/vennel-room-refused.png'})
  console.log(JSON.stringify({visibleActivation:true,secondTab:true,oldTabRefusal:true,privateMessage:true,reloadResume:true,boxRestart:true,linkRelayRestart:true,renewal:true,keeperWithdrawal:true,guestHeld:true,explicitGuestRefusal:true,publicRoomFrames:counters.after,pageErrors:errors}))
}catch(error){
  for(let i=0;i<pages.length;i++){await pages[i].screenshot({path:`/tmp/vennel-room-failed-${i}.png`}).catch(()=>{});console.error('page',i,await pages[i].locator('#bothyRoomStatus').textContent().catch(()=>''),await pages[i].locator('#status').textContent().catch(()=>''),await pages[i].locator('#bothyRoomConnection').textContent().catch(()=>''))}
  console.error('page errors',errors);throw error
}finally{ownerKey.fill(0);guestKey.fill(0);for(const c of contexts)await c.close();await browser.close();await new Promise(r=>server.close(r))}
