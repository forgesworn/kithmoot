// A Bothy room activated before its board travelled over Bothy, carried across
// an app update: the keeper renews the room's grants, the member activates the
// room again, and the board then crosses through the box, including the card
// written before the update. Real claimed Bothy, pinned Link WASM, local public
// relay and two built PWAs served at one origin. ROOM_UPGRADE_FROM names the
// earlier build's `app/dist`; this checkout's `app/dist` is the later one. Run
// it under Vennel's `lab/browser-room-activation.mjs` services, in place of
// `test/browser-room-live.mjs` (see docs/private-bothy-files.md).
import {chromium} from '@playwright/test'
import {finalizeEvent,getPublicKey,generateSecretKey} from 'nostr-tools/pure'
import {encodeJoinUrl,generateRoomSecret,deriveRoom,deriveChannel} from '@forgesworn/fold-kit'
import {expect} from '@playwright/test'
import {createHash} from 'node:crypto'
import {createServer} from 'node:http'
import {readFileSync,existsSync,mkdtempSync,cpSync,rmSync,mkdirSync} from 'node:fs'
import {resolve,extname} from 'node:path'
import assert from 'node:assert/strict'
import {enterRoom} from './browser-room-entry.mjs'

const control=process.env.LINK_BOTHY_CONTROL, linkRelay=process.env.LINK_TEST_RELAY, earlier=process.env.ROOM_UPGRADE_FROM
if(!control || new URL(control).hostname!=='127.0.0.1' || !linkRelay?.startsWith('wss://')) throw new Error('Set loopback Bothy control and WebPKI Link relay.')
if(!earlier || !existsSync(resolve(earlier,'index.html'))) throw new Error('Set ROOM_UPGRADE_FROM to an earlier build’s app/dist.')
const artifactDir=resolve(process.env.ROOM_ARTIFACT_DIR ?? 'release/browser-room')
mkdirSync(artifactDir,{recursive:true})
const root=mkdtempSync(resolve(artifactDir,'build-'))
// One origin throughout: what it serves changes, as a deployment does.
const publish=dist=>{rmSync(root,{recursive:true,force:true});mkdirSync(root);cpSync(resolve(dist),root,{recursive:true})}
publish(earlier)
const server=createServer((req,res)=>{
  const pathname=new URL(req.url,'http://localhost').pathname
  const file=resolve(root,pathname.replace(/^\/j\//,'') || 'index.html')
  if(!file.startsWith(root+'/') || !existsSync(file)){res.writeHead(404);res.end();return}
  const mime={'.html':'text/html','.js':'text/javascript','.wasm':'application/wasm','.css':'text/css','.json':'application/json','.webmanifest':'application/manifest+json','.svg':'image/svg+xml','.png':'image/png'}
  res.setHeader('Content-Type',mime[extname(file)]??'application/octet-stream');res.setHeader('Cache-Control','no-store');res.end(readFileSync(file))
})
await new Promise(r=>server.listen(0,'127.0.0.1',r))
const app=`http://127.0.0.1:${server.address().port}/j/`, publicRelay=process.env.LINK_PUBLIC_RELAY ?? 'ws://127.0.0.1:7777'
if(new URL(publicRelay).hostname!=='127.0.0.1' || new URL(publicRelay).protocol!=='ws:')throw new Error('Public fixture relay must be loopback.')
const launchOptions={args:[`--host-resolver-rules=MAP ${new URL(linkRelay).hostname} 127.0.0.1`]}
const browser=await chromium.launch(launchOptions)
const ownerKey=new Uint8Array(createHash('sha256').update('kithmoot-g5-fixture-signer-v2:alice').digest()), guestKey=generateSecretKey()
const secret=generateRoomSecret(), room=deriveRoom(secret), url=encodeJoinUrl(app,secret,[publicRelay])
const boardScope=deriveChannel(room.roomId,room.roomKey,'board').id
const wireScopes=new Set([room.roomId,deriveChannel(room.roomId,room.roomKey,'control').id,boardScope])
const contexts=[], errors=[], counters={before:0,after:0};let activated=false
const attach=page=>{
  page.on('pageerror',e=>errors.push(e.message))
  page.on('websocket',socket=>socket.on('framesent',frame=>{
    if(typeof frame.payload!=='string')return
    try{const f=JSON.parse(frame.payload), scoped=f[0]==='REQ'?f.slice(2).some(x=>x['#d']?.some(d=>wireScopes.has(d))):f[0]==='EVENT'&&f[1]?.tags?.some(t=>t[0]==='d'&&wireScopes.has(t[1]));if(scoped)counters[activated?'after':'before']++}catch{}
  }))
}
const setup=async key=>{
  const context=await browser.newContext({viewport:{width:1440,height:900}});contexts.push(context)
  await context.exposeFunction('fixturePublicKey',()=>getPublicKey(key));await context.exposeFunction('fixtureSign',e=>finalizeEvent(e,key))
  await context.addInitScript(()=>{window.nostr={getPublicKey:()=>window.fixturePublicKey(),signEvent:e=>window.fixtureSign(e)}})
  await context.addInitScript(({linkRelay,publicRelay})=>{
    const Native=window.WebSocket
    window.WebSocket=class extends Native{constructor(url,protocols){super(String(url)===linkRelay||String(url).startsWith(publicRelay)?url:publicRelay+'/auxiliary',protocols)}}
  },{linkRelay,publicRelay})
  const page=await context.newPage();attach(page)
  await page.goto(app+'?signin=nostr');await page.getByRole('button',{name:/Browser extension/}).click()
  await page.locator('#openAppSettings').click();await page.locator('#settingsRowrelays').click()
  await page.locator('#bothySettingsOpen').click();await page.locator('#bothyRelays').fill(linkRelay)
  await page.getByRole('button',{name:'Connect or resume',exact:true}).click()
  await page.getByText('Ready to pair. Paste a current code from your Bothy.',{exact:true}).waitFor()
  const {uri}=await(await fetch(control+'/pairing',{method:'POST'})).json()
  await page.locator('#bothyCode').fill(uri);await page.getByRole('button',{name:'Pair Bothy',exact:true}).click()
  await page.locator('#bothyStatus').filter({hasText:'Bothy paired and saved'}).waitFor({timeout:90000})
  await page.locator('#bothyClose').click()
  await page.goto(url);await page.reload();await enterRoom(page)
  await page.evaluate(async()=>{await navigator.serviceWorker.ready})
  return {context,page}
}
const routing=async page=>{await page.locator('#roomIdentity').click();await page.locator('#infoRowPrivacy').click();await page.locator('#roomBothySettings').click();await page.locator('#bothyRoomRoute option').first().waitFor({state:'attached',timeout:15000})}
const routed=async(page,button,words)=>{
  await routing(page);await page.locator(button).click()
  await page.locator('#bothyRoomStatus').filter({hasText:words}).waitFor({timeout:120000})
  await page.locator('#bothyRoomClose').click()
}
const board=page=>page.frameLocator('#roomBoardPanel iframe')
const card=(page,title)=>board(page).getByRole('link',{name:title,exact:true})
const composer=page=>board(page).getByRole('textbox',{name:'Add a card to To do',exact:true})
const openBoards=async page=>{await page.locator('#railBoards').click();await expect(page.getByRole('heading',{name:'Boards',exact:true})).toBeVisible()}
const backToChat=async page=>{await page.locator('#railChats').click();if(!await page.locator('#chatInput').isVisible())await page.getByRole('button',{name:'Open Untitled room',exact:true}).click();await expect(page.locator('#chatInput')).toBeVisible()}
const write=async(page,title)=>{await expect(composer(page)).toBeVisible({timeout:45000});await composer(page).fill(title);await composer(page).press('Enter');await expect(card(page,title)).toBeVisible()}
// The later build's board, once everything it holds has reached the room.
const settled=page=>expect(page.locator('#roomBoardStatus')).toHaveText('Shared with everyone in this room.',{timeout:60000})
const shoot=(page,name)=>page.screenshot({path:resolve(artifactDir,`vennel-room-upgrade-${name}.png`)})
const before='Written before the update', after='Written after the route gained the board'
let proof
try{
  const owner=await setup(ownerKey);console.error('owner paired and public room open on the earlier build')
  const guest=await setup(guestKey);console.error('guest paired and public room open on the earlier build')
  await owner.page.locator('#chatInput').fill('Public positive control');await owner.page.locator('#chatInput').press('Enter')
  await guest.page.locator('#chatLog').filter({hasText:'Public positive control'}).waitFor()
  assert(counters.before>0)
  await routing(owner.page);await owner.page.locator('#bothyRoomKeeper').check();await owner.page.locator('#bothyRoomActivate').click()
  await owner.page.locator('#bothyRoomStatus').filter({hasText:'This room now uses its selected private relay'}).waitFor({timeout:120000})
  await owner.page.locator('#bothyRoomClose').click()
  await routed(guest.page,'#bothyRoomActivate','This room now uses its selected private relay')
  activated=true;console.error('both activated on the earlier build')
  await owner.page.locator('#chatInput').fill('Private before the update');await owner.page.locator('#chatInput').press('Enter')
  await guest.page.locator('#chatLog').filter({hasText:'Private before the update'}).waitFor({timeout:45000})
  // The earlier build offers the board in a Bothy room, but its route was never granted the board.
  await openBoards(owner.page);await write(owner.page,before);await shoot(owner.page,'earlier-keeper-board');await backToChat(owner.page)
  await new Promise(r=>setTimeout(r,5000))
  assert.equal(counters.after,0,'the earlier build must not have sent the board anywhere public')

  publish(resolve('app/dist'));console.error('later build published at the same origin')
  for(const person of [owner,guest]){
    const page=person.page
    await page.evaluate(async()=>{const r=await navigator.serviceWorker.getRegistration();await r?.update()})
    await expect(page.locator('#updateApp')).toBeVisible({timeout:90000})
    await Promise.all([page.waitForEvent('load',{timeout:60000}),page.locator('#updateApp').click()])
    await enterRoom(page)
  }
  console.error('both updated through Update now')
  // A route without the board's scope: no board, and the note says what to do.
  await openBoards(guest.page)
  await expect(guest.page.getByText('goes through a Bothy route set up before boards could go that way',{exact:false})).toBeVisible({timeout:30000})
  await shoot(guest.page,'later-member-note');await backToChat(guest.page)

  await routed(owner.page,'#bothyRoomRenew','The private relay confirmed renewed')
  console.error('keeper renewed the room grants')
  await routed(guest.page,'#bothyRoomActivate','This room now uses its selected private relay')
  console.error('member activated the room again')
  // No reload: the note asks for nothing more than these two choices.
  await openBoards(guest.page)
  await expect(card(guest.page,before)).toBeVisible({timeout:90000})
  await write(guest.page,after);await settled(guest.page);await shoot(guest.page,'later-member-board');await backToChat(guest.page)
  await openBoards(owner.page)
  await expect(card(owner.page,after)).toBeVisible({timeout:90000});await expect(card(owner.page,before)).toBeVisible()
  await settled(owner.page);await shoot(owner.page,'later-keeper-board');await backToChat(owner.page)
  await owner.page.locator('#chatInput').fill('Private after the update');await owner.page.locator('#chatInput').press('Enter')
  await guest.page.locator('#chatLog').filter({hasText:'Private after the update'}).waitFor({timeout:45000})
  assert.equal(counters.after,0);assert.deepEqual(errors,[])
  proof={earlierBuildBoardStayedOffPublic:true,updatedThroughUpdateNow:true,noteBeforeRenewal:true,keeperRenewed:true,memberActivatedAgain:true,earlierCardArrived:true,laterCardArrived:true,publicRoomFrames:counters.after,pageErrors:errors}
  console.log(JSON.stringify({browser:browser.version(),earlierIndexSha256:createHash('sha256').update(readFileSync(resolve(earlier,'index.html'))).digest('hex'),laterIndexSha256:createHash('sha256').update(readFileSync(resolve('app/dist/index.html'))).digest('hex'),...proof}))
}catch(error){
  let i=0;for(const c of contexts)for(const p of c.pages()){await p.screenshot({path:resolve(artifactDir,`vennel-room-upgrade-failed-${i}.png`)}).catch(()=>{});console.error('page',i++,await p.locator('#bothyRoomStatus').textContent().catch(()=>''),await p.locator('#status').textContent().catch(()=>''))}
  console.error('page errors',errors);throw error
}finally{ownerKey.fill(0);guestKey.fill(0);for(const c of contexts)await c.close();await browser.close();await new Promise(r=>server.close(r));rmSync(root,{recursive:true,force:true})}
