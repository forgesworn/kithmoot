import { readRuntimeConfig } from './mixed-invitation-runtime-config.mjs'
import { npubEncode } from 'nostr-tools/nip19'
import { sha256, endpointSummary, frameSummary, httpSummary, matchesNeedleNow, withinBudget, assertProspectiveNeedles, windowTransition, adminPolicyNeedles, keyClass, safeNumber } from './mixed-invitation-metadata-audit.mjs'
import { permittedApprovalDto, publicOrdinaryContextDto } from './mixed-invitation-approval-guard.mjs'
import { safeErrorDiagnostic } from './mixed-invitation-error-diagnostic.mjs'
import { chromium } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdir, readdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

const labProfile = process.env.MIXED_INVITATION_LAB_PROFILE ?? 'Invitation1'
if (!['Invitation1', 'InvitationAdmins2'].includes(labProfile)) throw new Error('Explicit supported invitation lab profile required')
const app = process.env.MIXED_INVITATION_APP_URL ?? 'http://localhost:28445/j/'
const control = process.env.MIXED_INVITATION_CONTROL_URL ?? 'http://127.0.0.1:28440'
if (!['localhost', '127.0.0.1'].includes(new URL(app).hostname) || !['localhost', '127.0.0.1'].includes(new URL(control).hostname)) throw new Error('Disposable browser lab requires loopback app and control endpoints')
const bark = path.resolve(process.env.MIXED_INVITATION_BARK_PATH ?? '.lab/bark-built-6c303065')
if (labProfile === 'InvitationAdmins2' && !process.env.MIXED_INVITATION_BROWSER_PROFILE) throw new Error('Admin2 requires an explicit fresh private browser profile path')
const profile = path.resolve(process.env.MIXED_INVITATION_BROWSER_PROFILE ?? '.lab/browser-profile')
const sourceRoot = path.resolve('.')
const sourceModules = new Set((await Promise.all(['app/src','src'].map(dir=>readdir(path.resolve(dir),{recursive:true})))).flat().map(name=>path.basename(name)))
const packageModules = new Set((await readdir(path.resolve('packages'),{recursive:true})).map(name=>path.basename(name)))
const dependencyModules = new Set((await Promise.all(['node_modules/.vite/deps','node_modules/signet-login/dist'].map(dir=>readdir(path.resolve(dir)).catch(()=>[])))).flat())
const barkModules = new Set((await readdir(bark)).filter(name=>name.endsWith('.js')))
await mkdir(profile, { recursive: true, mode: 0o700 })
const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
  args: ['--enable-unsafe-extension-debugging', `--disable-extensions-except=${bark}`, `--load-extension=${bark}`],
})
const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker')
const extension = new URL(worker.url()).host
const runtimeReady = await fetch(control + '/ready')
if (!runtimeReady.ok) throw new Error('Read-only runtime status unavailable')
const runtimeConfig = readRuntimeConfig(await runtimeReady.json())
const blockedNetworkAttempts=[]
const allowedNetworkOrigins = new Set([new URL(app).origin, new URL(app.replace(/^http/, 'ws')).origin, ...['linkUrl','relayUrl','publicRelay'].map(k => new URL(runtimeConfig[k]).origin)])
const knownOrigins = Object.fromEntries([[app,'app'],[app.replace(/^http/,'ws'),'app-socket'],[runtimeConfig.linkUrl,'link'],[runtimeConfig.relayUrl,'signer-relay'],[runtimeConfig.publicRelay,'public-relay']].map(([url,alias])=>[new URL(url).origin,alias]))
// Match only forbidden destinations. Selected ownstack sockets are wholly
// native: they never enter a Playwright socket route or proxy.
await context.routeWebSocket(url => !allowedNetworkOrigins.has(url.origin), socket => {
  blockedNetworkAttempts.push({ kind: 'websocket', ...endpointSummary(socket.url(),knownOrigins) })
  socket.close({ code: 1008, reason: 'Disposable ownstack lab allows only its explicitly selected relays' })
})
await context.route('**/*', route => { const u=new URL(route.request().url());if(route.request().url().startsWith(`chrome-extension://${extension}/`) || allowedNetworkOrigins.has(u.origin))return route.continue();blockedNetworkAttempts.push({kind:'request',...endpointSummary(route.request().url(),knownOrigins)});return route.abort('blockedbyclient') })
const page = await context.newPage()
const namedWindows = new Set(['bootstrap', 'ordinary', 'private', 'fault', 'reconnect', 'refusal', 'admin-policy', 'admin-refusal'])
let active, result, failures = 0, observe = true, windowName = 'bootstrap', needles = [], observations = [], violations = 0, activePrivateTerms = []
let observedBytes = 0, observerOverflow = false, unattributedFrames = 0, frameCount = 0, httpBodyUnobserved = 0, publicControl = null, controlSubscription
const closedWindows = []
const digest = sha256
const fieldClass = keyClass
const kindClass = safeNumber
const record = value => { if(observations.length < 10000)observations.push(value);else observerOverflow=true }

function endpointOf(url) { const result=endpointSummary(url,knownOrigins);return result.endpointUnknown?undefined:result }
function frame(payload, source, endpoint) {
  if (!observe) return
  const wire = Buffer.from(payload), size=withinBudget(observedBytes,wire.length)
  observedBytes=size.bytes;observerOverflow ||= size.overflow
  frameCount++
  if (!endpoint) unattributedFrames++
  violations+=matchesNeedleNow(needles,[wire])
  record({window:windowName,source,...(endpoint??{endpointUnknown:true}),...frameSummary(wire,controlSubscription)})
}
function httpRequest(url, method, headers, body, hasPostData, source) {
  if(!observe)return
  const endpoint=endpointOf(url)
  const bytes=body==null?null:Buffer.from(body)
  if(!endpoint)unattributedFrames++
  if(bytes) { const size=withinBudget(observedBytes,bytes.length);observedBytes=size.bytes;observerOverflow ||= size.overflow }
  if(hasPostData&&!bytes)httpBodyUnobserved++
  violations+=matchesNeedleNow(needles,[url,...Object.entries(headers??{}).flat(),bytes])
  record({window:windowName,...httpSummary(url,method,headers,bytes,hasPostData,source,knownOrigins)})
}
page.on('websocket', socket => { socket.on('framesent', e => frame(e.payload, 'app-websocket', endpointOf(socket.url()))); socket.on('socketerror', () => failures++) })
page.on('request', request => { const body=request.postDataBuffer();httpRequest(request.url(),request.method(),request.headers(),body,!!body,'app-http') })
const diagnostics=[]
const clean = (e,source='controller-operation') => safeErrorDiagnostic(e,new URL(app).origin,sourceRoot,sourceModules,source,
  {barkOrigin:`chrome-extension://${extension}`,barkModules,packageModules,dependencyModules,privateTerms:[...needles,...activePrivateTerms]})
let diagnosticsOverflow=false
page.on('pageerror', e => { failures++; if(diagnostics.length<100)diagnostics.push(clean(e,'app-pageerror'));else diagnosticsOverflow=true })
// CDP observes the built extension's actual worker socket, in addition to app
// sockets. Payloads are immediately reduced to metadata and digests.
const browserCdp = await context.browser().newBrowserCDPSession()
const workerSessions = new Map(), workerTargets = new Set(), enabledWorkers = new Set(), workerSocketEndpoints = new Map()
const workerCoverage = { attached: 0, enabled: 0, detached: 0, errors: 0 }
let cdpCommand = 0
async function attachWorker(target) {
  if (target.type !== 'service_worker' || !target.url.startsWith(`chrome-extension://${extension}/`) || workerTargets.has(target.targetId)) return
  workerTargets.add(target.targetId)
  try {
    const { sessionId } = await browserCdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: false })
    const command = ++cdpCommand
    workerSessions.set(sessionId, { target: target.targetId, command })
    workerCoverage.attached++
    await browserCdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id: command, method: 'Network.enable' }) })
  } catch { workerTargets.delete(target.targetId); workerCoverage.errors++ }
}
browserCdp.on('Target.receivedMessageFromTarget', event => {
  const watched = workerSessions.get(event.sessionId)
  if (!watched) return
  try {
    const m = JSON.parse(event.message)
    if (m.id === watched.command) {
      if (m.error) workerCoverage.errors++
      else if (!enabledWorkers.has(watched.target)) { enabledWorkers.add(watched.target); workerCoverage.enabled++ }
    }
    if (m.method === 'Network.webSocketCreated') workerSocketEndpoints.set(`${event.sessionId}:${m.params.requestId}`, endpointOf(m.params.url))
    if (m.method === 'Network.webSocketFrameSent') frame(m.params.response.opcode === 2 ? Buffer.from(m.params.response.payloadData, 'base64') : m.params.response.payloadData, 'bark-worker-websocket', workerSocketEndpoints.get(`${event.sessionId}:${m.params.requestId}`))
    if (m.method === 'Network.requestWillBeSent') {
      const request=m.params.request
      httpRequest(request.url,request.method,request.headers,request.postData,request.hasPostData,'bark-worker-http')
    }
  } catch { workerCoverage.errors++ }
})
browserCdp.on('Target.detachedFromTarget', event => {
  const watched = workerSessions.get(event.sessionId)
  if (!watched) return
  workerSessions.delete(event.sessionId); workerTargets.delete(watched.target); enabledWorkers.delete(watched.target); workerCoverage.detached++
})
browserCdp.on('Target.targetDestroyed', event => {
  if (!workerTargets.delete(event.targetId)) return
  enabledWorkers.delete(event.targetId)
  for (const [session, watched] of workerSessions) if (watched.target === event.targetId) workerSessions.delete(session)
  workerCoverage.detached++
})
browserCdp.on('Target.targetCreated', event => { void attachWorker(event.targetInfo) })
browserCdp.on('Target.targetInfoChanged', event => { void attachWorker(event.targetInfo) })
await browserCdp.send('Target.setDiscoverTargets', { discover: true })
for (const target of (await browserCdp.send('Target.getTargets')).targetInfos) await attachWorker(target)

function auditWindow() {
  const endpoints={}
  for(const entry of observations) {
    const key=`${entry.source} ${entry.originAlias??'[unattributed]'} ${entry.originSha256??''} ${entry.pathSha256??''}`
    const count=endpoints[key]??={items:0,bytes:0}
    count.items++;count.bytes+=entry.length
  }
  return {name:windowName,workerCoverage:{...workerCoverage},currentWorkerTargets:workerTargets.size,
    observerOverflow,observedBytes,frames:frameCount,unattributedFrames,httpBodyUnobserved,violations,checkedNeedles:needles.length,
    publicControl,observationChecksPassed:workerCoverage.enabled>0&&workerCoverage.errors===0&&!observerOverflow&&unattributedFrames===0&&httpBodyUnobserved===0&&publicControl?.outboundObserved===true&&publicControl?.closeObserved===true&&publicControl?.eose===true,
    coverageScope:'Actual app page outgoing WebSocket and reported HTTP; Bark extension worker outgoing WebSocket and CDP-reported HTTP. Prospective needles only. Browser-excluded app headers, unreported CDP bodies, Android traffic and retrospective audits are outside this observation.',
    sourceCounts:observations.reduce((counts,o)=>(counts[o.source]=(counts[o.source]??0)+1,counts),{}),
    endpoints,observationDigest:digest(JSON.stringify(observations))}
}
function startWindow(name, nextNeedles) {
  const transition=windowTransition(auditWindow(),name,nextNeedles,namedWindows)
  const previous=transition.closed
  closedWindows.push(previous)
  windowName=transition.name;needles=transition.needles;observations=[];violations=0;observedBytes=0;observerOverflow=false;unattributedFrames=0;frameCount=0;httpBodyUnobserved=0;publicControl=null;controlSubscription=undefined
  return {started:name,previous}
}
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value==='object' ? Object.fromEntries(Object.keys(value).sort().map(k=>[k,stable(value[k])])) : value
const same = (left,right) => JSON.stringify(stable(left))===JSON.stringify(stable(right))
async function approvalDetails(p) {
  const requestId=new URL(p.url()).searchParams.get('requestId')
  if(!requestId)throw new Error('Bark approval has no request ID')
  return p.evaluate(requestId=>new Promise((resolve,reject)=>chrome.runtime.sendMessage({type:'bark-approval-query',requestId},v=>{
    if(chrome.runtime.lastError)reject(new Error('Bark approval query failed'));else resolve(v)
  })),requestId)
}
function checkApproval(details, expected) {
  if(!expected || typeof expected!=='object' || Array.isArray(expected))throw new Error('Prospective typed Bark binding required')
  const allowed=new Set(['getPublicKey','getRelays','signEvent','heartwood_provision_rendezvous'])
  if(!allowed.has(details?.method)||details.method!==expected.method)throw new Error('Unapproved Bark method')
  if(details.origin!==new URL(app).origin||details.origin!==expected.origin||details.pubkey!==expected.pubkey)throw new Error('Bark site or persona binding mismatch')
  if(!Number.isFinite(details.expiresAt)||details.expiresAt<=Date.now())throw new Error('Bark approval expired')
  if(details.method==='signEvent') {
    if(!details.event||!expected.event||!same(details.event,expected.event)||details.provision)throw new Error('Bark event binding mismatch')
  } else if(details.method==='heartwood_provision_rendezvous') {
    if(!details.provision||!expected.provision||!same(details.provision,expected.provision)||details.event)throw new Error('Bark provision binding mismatch')
  } else if(details.event||details.provision||expected.event||expected.provision)throw new Error('Bark request type mismatch')
  const actual={method:details.method,origin:details.origin,pubkey:details.pubkey,event:details.event??null,provision:details.provision??null}
  if(!expected.sha256||digest(JSON.stringify(stable(actual)))!==expected.sha256)throw new Error('Bark request digest mismatch')
}

const ordinaryScenarios=new Set(['alice-created','keeper-created'])
const HEX64=/^[0-9a-f]{64}$/
function ordinaryScenario(args) {
  if(!ordinaryScenarios.has(args?.scenario)||args.actor!=='alice')throw new Error('Named synthetic ordinary scenario and Alice actor required')
  return args.scenario
}
function boundedOrdinaryText(value,limit,label) {
  if(typeof value!=='string'||!value.trim()||Buffer.byteLength(value)>limit||/[\u0000-\u001f\u007f]/.test(value))throw new Error(`Bounded ${label} required`)
  return value
}
function expectedHash(value,label) { if(typeof value!=='string'||!HEX64.test(value))throw new Error(`Expected ${label} digest required`);return value }
function expectedPubkey(value) { if(typeof value!=='string'||!HEX64.test(value))throw new Error('Independent expected participant public key required');return value }
async function ordinarySnapshot(args) {
  const scenario=ordinaryScenario(args)
  const account=args.expectedAccountPubkey===undefined?undefined:expectedPubkey(args.expectedAccountPubkey)
  const roomOpen=await page.locator('#roomArea').isVisible()
  const sheet=page.locator('#roomSheet')
  const openedSheet=roomOpen&&!await sheet.evaluate(element=>element.open)
  if(openedSheet){
    await page.locator('#roomIdentity').click()
    await page.waitForFunction(()=>document.querySelector('#roomSheet')?.open===true,null,{timeout:5000})
  }
  try {
    if(roomOpen){
      await page.waitForFunction(expected=>{
        const rows=[...document.querySelectorAll('#sheetRoster > .rosterRow[data-participant]')]
        return expected ? rows.some(row=>row.dataset.participant===expected) : rows.length>0
      },account??null,{timeout:account?15000:5000}).catch(error=>{if(error.name!=='TimeoutError')throw error})
    }
    const state=await page.evaluate(async expectedAccount => {
    const hash=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))).map(byte=>byte.toString(16).padStart(2,'0')).join('')
    const room=document.querySelector('#roomArea'), title=document.querySelector('#roomTitle')?.textContent??''
    const share=document.querySelector('#shareUrl')?.value??''
    const sheet=document.querySelector('#roomSheet')
    const roster=sheet?.open?[...document.querySelectorAll('#sheetRoster > .rosterRow[data-participant]')].map(row=>row.dataset.participant).filter(Boolean):[]
    const rosterObserved=!!sheet?.open&&roster.length>0
    const messages=[...document.querySelectorAll('#chatLog .msg[data-message-id]')]
    const valid=messages.filter(row=>/^[0-9a-f]{64}$/.test(row.dataset.messageAuthor??''))
    const last=await Promise.all(valid.slice(-10).map(async row=>({idSha256:await hash(row.dataset.messageId??''),
      authorSha256:await hash(row.dataset.messageAuthor),bodySha256:await hash(row.querySelector('.messageBody .bubble .text')?.textContent??''),mine:row.classList.contains('mine')})))
    const host=document.querySelector('#hostPanel'), rotate=document.querySelector('#rotateShare')
    return {roomOpen:!!room&&!room.hidden,roomTitleSha256:await hash(title),shareUrlSha256:share?await hash(share):null,
      rosterObserved,rosterCount:rosterObserved?roster.length:null,participantSha256:rosterObserved?(await Promise.all(roster.map(hash))).sort():[],
      accountPresent:expectedAccount===undefined?undefined:rosterObserved?roster.includes(expectedAccount):null,
      hostAvailable:!!host&&!host.hidden,hostRowCount:document.querySelectorAll('#hostList .hostRow').length,
      rotateAvailable:!!rotate&&!rotate.hidden,messageCount:valid.length,discardedMessageRows:messages.length-valid.length,lastMessages:last}
    },account)
    if(account&&!state.accountPresent)throw new Error('Expected account not observed in actual room-info roster')
    return {scenario,actor:'alice',...state}
  } finally { if(openedSheet)await page.locator('#roomSheetClose').click() }
}

let inlineSigninBusy=false, inlineSigninPending=false
async function signinInline() {
  if(inlineSigninBusy||inlineSigninPending)return {handling:true,selected:false}
  inlineSigninBusy=true
  try {
    if(new URL(page.url()).origin!==new URL(app).origin)throw new Error('Signet picker is outside exact local app origin')
    const dialog=page.locator('#signet-login-dialog')
    if(!await dialog.isVisible()||await dialog.locator('h2').textContent()!=='Sign in to KithMoot')throw new Error('Expected KithMoot Signet picker is not visible')
    const extension=dialog.locator('button[data-choice="nip07"]')
    if(!await extension.isVisible()){
      const advanced=dialog.locator('button[data-action="advanced"]')
      if(!await advanced.isVisible()||await advanced.textContent()!=='Advanced')throw new Error('Exact Signet Advanced control unavailable')
      await advanced.click()
    }
    if(await extension.count()!==1||!await extension.isVisible()||!(await extension.textContent())?.includes('Browser extension'))throw new Error('Exact browser-extension Signet choice unavailable')
    inlineSigninPending=true
    try { await extension.click() } catch(error) { inlineSigninPending=false;throw error }
    return {selected:true,method:'nip07',originMatched:true}
  } finally { inlineSigninBusy=false }
}

async function continueOrdinaryDoor(args) {
  let lastJoin=0,lastNostr=0
  const deadline=Date.now()+90_000
  while(Date.now()<deadline){
    if(await page.locator('#roomArea').isVisible())return {roomOpen:true}
    if(context.pages().some(p=>p.url().startsWith(`chrome-extension://${extension}/approve.html`))){await page.waitForTimeout(200);continue}
    if(await page.locator('#signet-login-dialog').isVisible()){
      if(!inlineSigninPending)await signinInline()
      await page.waitForTimeout(200);continue
    }
    if(inlineSigninPending){
      if(await page.locator('#signOut').evaluate(e=>!e.hidden))inlineSigninPending=false
      else {await page.waitForTimeout(200);continue}
    }
    const join=page.locator('#join')
    if(await join.isVisible()&&await join.isEnabled()){
      const label=(await join.textContent())?.trim()??''
      if(label==='Join'&&await page.locator('#joinNostr').isVisible()&&Date.now()-lastNostr>5000){
        lastNostr=Date.now();await page.locator('#joinNostr').click();continue
      }
      if(/^Continue (?:with your Nostr extension|with your Nostr account|as .+)$/.test(label)&&Date.now()-lastJoin>5000){
        if(await page.locator('#displayName').isVisible()&&!await page.locator('#displayName').inputValue())await page.locator('#displayName').fill(boundedOrdinaryText(args.displayName,64,'joining display name'))
        if(await page.locator('#joinMediaChoice').isVisible()){
          await page.locator('#joinMic').uncheck()
          await page.locator('#joinCamera').uncheck()
        }
        lastJoin=Date.now();await join.click();continue
      }
      if(label==='Join'&&!await page.locator('#joinNostr').isVisible())throw new Error('Ordinary door only offers visitor identity; refusing')
    }
    await page.waitForTimeout(200)
  }
  throw new Error('Actual signed-in ordinary room did not open after its UI door')
}

async function ordinaryDoorDiagnostics() {
  return page.evaluate(async () => {
    const hash=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))).map(byte=>byte.toString(16).padStart(2,'0')).join('')
    const status=document.querySelector('#status'), message=status?.textContent??''
    const join=document.querySelector('#join'), label=join?.textContent?.trim()??''
    const joinMode=!join||join.hidden?'hidden':label==='Join'?'name':label==='Continue with your Nostr extension'?'extension':/^Continue (?:with your Nostr account|as .+)$/.test(label)?'account':'other'
    return {roomOpen:!!document.querySelector('#roomArea')&&!document.querySelector('#roomArea').hidden,
      joinMode,joinEnabled:!!join&&!join.disabled,signetPickerVisible:!!document.querySelector('#signet-login-dialog[open]'),
      statusHasText:!!message,statusProblemTone:!!message&&!status.classList.contains('progress')&&!status.classList.contains('done'),
      statusTone:!message?'empty':status.classList.contains('progress')?'progress':status.classList.contains('done')?'done':'problem',
      statusLength:message.length,statusSha256:message?await hash(message):null}
  })
}

async function settings() {
  for (let i=0;i<30;i++) { if(await page.locator('#settingsPane').isVisible()) break; await page.locator('#openAppSettings').evaluate(e=>e.click()); await page.waitForTimeout(100) }
  if(await page.locator('#settingsPane').getAttribute('data-page') !== 'main') await page.locator('#settingsBack').click()
  await page.locator('#settingsPane .infoRow').filter({has:page.locator('.infoRowTitle',{hasText:/^Connections$/})}).click()
}
async function openPanel(kind) {
  await page.bringToFront()
  for(const id of ['#mlsWitnessSettings','#mlsRoomDevelopment','#mlsGrantDevelopment']) if(await page.locator(id).isVisible()) {
    const close=id==='#mlsWitnessSettings' ? page.locator('#mlsWitnessClose') : page.locator(id+' [data-close]'); await close.click()
  }
  await settings()
  const ids={account:'mlsWitnessSettingsOpen',room:'mlsRoomDevelopmentOpen',grant:'mlsGrantDevelopmentOpen'}
  await page.locator('#'+ids[kind]).click()
  await page.waitForFunction(kind=>window.__mixedInvitationLab?.ready()[kind==='room'?'rooms':kind==='grant'?'grants':'account'],kind)
  return {opened:kind}
}
async function requireLabProfile() {
  await page.waitForFunction(() => typeof window.__mixedInvitationLab?.profile === 'function', null, { timeout: 15000 })
  const actual = await page.evaluate(() => window.__mixedInvitationLab?.profile())
  if (actual !== labProfile) throw new Error('Actual browser preview differs from the explicitly selected controller profile')
  return { profile: actual, experimental: true, qualificationOnly: true }
}
async function run(step,args) {
  if(step === 'lab-profile') return requireLabProfile()
  if(step==='configure-ownstack') {
    await settings();await page.locator('#defaultRelaySettings').click()
    while(await page.locator('#relayList button[aria-label^="Remove "]').count())await page.locator('#relayList button[aria-label^="Remove "]').first().click()
    await page.locator('#relayUrl').fill(runtimeConfig.publicRelay);await page.locator('#relayAddForm button[type=submit]').click();await page.locator('#relaySave').click();await page.locator('#relaySettingsClose').click()
    await settings();await page.locator('#settingsBack').click();await page.locator('#appProfileSettings').click()
    await page.locator('#lookupProfiles').uncheck();await page.locator('#verifyAddresses').uncheck();await page.locator('#profileSettingsClose').click()
    return {configured:true,publicProfiles:false,nip05:false,defaultRelaySha256:digest(runtimeConfig.publicRelay),blockedAttemptsBeforeConfiguration:blockedNetworkAttempts.length}
  }
  if(step==='reload-built-bark') {
    const p = await context.newPage(); await p.goto(`chrome-extension://${extension}/diagnostic.html`)
    await p.evaluate(() => chrome.runtime.reload()).catch(() => {})
    await p.close().catch(() => {})
    return { extensionReloadRequested: true }
  }
  if(step==='pair-bark') {
    const cfg=await (await fetch(control+'/private/signer?persona='+encodeURIComponent(args.persona??'alice'))).json()
    const popup=await context.newPage();await popup.goto(`chrome-extension://${extension}/popup.html`)
    // Wait until the popup has loaded stored instances before choosing the
    // setup versus Add Signer form; its static HTML initially shows setup.
    await popup.waitForTimeout(250)
    if (await popup.locator('#instance-list .instance-card').count()) await popup.locator('#show-add-btn').waitFor({ state: 'visible', timeout: 60000 })
    let input = '#heartwood-address', button = '#pair-btn'
    if (!await popup.locator(input).isVisible()) {
      await popup.locator('#show-add-btn').click();input = '#add-address';button = '#add-pair-btn'
    }
    await popup.locator(input).evaluate((e,v)=>{e.value=v},cfg.bunkerUri)
    await popup.locator(button).click()
    await popup.waitForFunction(selector => !document.querySelector(selector)?.disabled, button, { timeout: 60000 })
    if (!await popup.locator('#pair-error').evaluate(e => e.classList.contains('hidden'))) throw new Error('Actual Bark pairing refused')
    await popup.waitForFunction(expected => document.getElementById('active-npub')?.textContent === expected && document.getElementById('connected-content')?.style.display !== 'none' && document.getElementById('status-dot')?.classList.contains('connected'), npubEncode(cfg.rootPub), { timeout: 60000 })
    await popup.locator(input).evaluate(e=>{e.value=''})
    await popup.close();return {paired:true,personaSha256:digest(cfg.rootPub),independentPublicPinMatched:true}
  }
  if(step==='signin') { await page.goto(app+'?signin=nostr'); if(await page.locator('#signOut').evaluateAll(es=>es.some(e=>!e.hidden)))return {signedIn:true,restored:true};await page.getByRole('button',{name:'Advanced',exact:true}).click();await page.getByRole('button',{name:/Browser extension/}).click();await page.locator('#homeSignIn').waitFor({state:'hidden',timeout:60000});return {signedIn:true} }
  if(step==='signin-inline')return signinInline()
  if(step==='ordinary-public-context') {
    await page.waitForFunction(()=>window.__mixedInvitationLab?.ready().ordinary===true,null,{timeout:5000})
    const state=publicOrdinaryContextDto(await page.evaluate(()=>window.__mixedInvitationLab.step('ordinary-public-context')))
    if(!state)throw new Error('Actual ordinary public binding has invalid shape')
    return state
  }
  if(step==='ordinary-create') {
    if(ordinaryScenario(args)!=='alice-created')throw new Error('Only Alice-created scenario creates a browser room')
    const name=boundedOrdinaryText(args.name,64,'synthetic room name')
    if(expectedHash(args.expectedNameSha256,'room name')!==digest(name))throw new Error('Room name digest mismatch')
    const opener=await page.locator('#newRoom').isVisible()?'#newRoom':'#homeNewRoom'
    await page.locator(opener).click()
    await page.locator('#newRoomDialog').waitFor({state:'visible'})
    await page.locator('#roomName').fill(name)
    await page.locator('#roomAsk').uncheck()
    await page.locator('#roomEnds').selectOption('0')
    if(await page.locator('#newRoomYourNameRow').isVisible())await page.locator('#newRoomYourName').fill(boundedOrdinaryText(args.displayName,64,'creator display name'))
    if(await page.locator('#roomAsk').isChecked()||await page.locator('#roomEnds').inputValue()!=='0')throw new Error('Persistent group-room UI choice did not hold')
    await page.locator('#create').click()
    await continueOrdinaryDoor(args)
    const snapshot=await ordinarySnapshot(args)
    if(snapshot.roomTitleSha256!==args.expectedNameSha256)throw new Error('Created room title differs from expected synthetic name')
    return {created:true,persistentGroup:true,admissionAsk:false,endsNever:true,...snapshot}
  }
  if(step==='ordinary-open-link') {
    const scenario=ordinaryScenario(args)
    const link=boundedOrdinaryText(args.url,8192,'private invitation URL')
    const parsed=new URL(link)
    if(parsed.origin!==new URL(app).origin||parsed.pathname!=='/j/'||!parsed.hash||parsed.username||parsed.password)throw new Error('Only exact local KithMoot invitation URL is allowed')
    if(expectedHash(args.expectedShareUrlSha256,'invitation')!==digest(link))throw new Error('Invitation digest mismatch')
    if(await page.locator('#roomArea').isVisible()&&await page.locator('#chatInput').inputValue())throw new Error('Send or discard current draft before opening another room')
    await page.goto('about:blank')
    await page.goto(parsed.href)
    return {scenario,actor:'alice',linkSha256:digest(link),opened:true,arrivalVisible:await page.locator('#identity').isVisible(),roomOpen:await page.locator('#roomArea').isVisible()}
  }
  if(step==='ordinary-join') {
    ordinaryScenario(args)
    await continueOrdinaryDoor(args)
    const snapshot=await ordinarySnapshot(args)
    if(!snapshot.roomOpen)throw new Error('Actual room UI did not open')
    return {joined:true,...snapshot}
  }
  if(step==='ordinary-send') {
    ordinaryScenario(args)
    const body=boundedOrdinaryText(args.body,512,'synthetic chat body')
    if(expectedHash(args.expectedBodySha256,'chat body')!==digest(body))throw new Error('Chat body digest mismatch')
    const before=await ordinarySnapshot(args)
    if(!before.roomOpen||before.roomTitleSha256!==expectedHash(args.expectedRoomTitleSha256,'room title'))throw new Error('Actual room does not match expected send target')
    const input=page.locator('#chatInput')
    if(await input.inputValue())throw new Error('Current chat draft must be empty')
    const count=await page.locator('#chatLog .msg.mine .messageBody .bubble .text').evaluateAll((nodes,text)=>nodes.filter(n=>n.textContent===text).length,body)
    await input.fill(body);await input.press('Enter')
    await page.waitForFunction(({text,count})=>[...document.querySelectorAll('#chatLog .msg.mine .messageBody .bubble .text')].filter(n=>n.textContent===text).length>count,{text:body,count},{timeout:30000})
    return {scenario:args.scenario,actor:'alice',bodySha256:digest(body),localMessageObserved:true,roomTitleSha256:before.roomTitleSha256}
  }
  if(step==='ordinary-receive') {
    ordinaryScenario(args)
    const bodySha256=expectedHash(args.expectedBodySha256,'received chat body')
    const authorSha256=expectedHash(args.expectedAuthorSha256,'independent sender')
    const before=await ordinarySnapshot(args)
    if(!before.roomOpen||before.roomTitleSha256!==expectedHash(args.expectedRoomTitleSha256,'room title'))throw new Error('Actual room does not match expected receive target')
    if(before.messageCount>5000)throw new Error('Bounded chat observation required')
    const prior=await page.evaluate(async expected=>{
      const hash=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))).map(byte=>byte.toString(16).padStart(2,'0')).join('')
      let count=0
      for(const row of document.querySelectorAll('#chatLog .msg[data-message-id]')){
        const author=row.dataset.messageAuthor
        if(row.classList.contains('mine')||!author||!/^[0-9a-f]{64}$/.test(author)||await hash(author)!==expected.author)continue
        if(await hash(row.querySelector('.messageBody .bubble .text')?.textContent??'')===expected.body)count++
      }
      return count
    },{body:bodySha256,author:authorSha256})
    await page.waitForFunction(async expected=>{
      const hash=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))).map(byte=>byte.toString(16).padStart(2,'0')).join('')
      let count=0
      for(const row of document.querySelectorAll('#chatLog .msg[data-message-id]')){
        const author=row.dataset.messageAuthor
        if(row.classList.contains('mine')||!author||!/^[0-9a-f]{64}$/.test(author)||await hash(author)!==expected.author)continue
        if(await hash(row.querySelector('.messageBody .bubble .text')?.textContent??'')===expected.body)count++
      }
      return count>expected.prior
    },{body:bodySha256,author:authorSha256,prior},{timeout:60000})
    return {scenario:args.scenario,actor:'alice',remoteMessageObserved:true,bodySha256,authorSha256,priorMatches:prior}
  }
  if(step==='ordinary-rotate') {
    if(ordinaryScenario(args)!=='alice-created')throw new Error('Fresh-link rotation belongs only to Alice-created scenario')
    const oldHash=expectedHash(args.expectedOldShareSha256,'old room link')
    const before=await ordinarySnapshot(args)
    if(!before.roomOpen||before.roomTitleSha256!==expectedHash(args.expectedRoomTitleSha256,'room title')||before.shareUrlSha256!==oldHash)throw new Error('Rotation target differs from actual room/link')
    await page.locator('#roomIdentity').click()
    await page.locator('#roomSheet').waitFor({state:'visible'})
    await page.locator('#infoInvite').click()
    await page.locator('#inviteDialog').waitFor({state:'visible'})
    if(!await page.locator('#rotateShare').isVisible())throw new Error('Actual creator fresh-link control is unavailable')
    await page.locator('#rotateShare').click()
    if(await page.locator('#actionTitle').textContent()!=='Replace the room link?'||await page.locator('#actionConfirm').textContent()!=='Replace link')throw new Error('Unexpected fresh-link confirmation')
    await page.locator('#actionConfirm').click()
    let changed=false
    try{await page.waitForFunction(async old=>{const value=document.querySelector('#shareUrl')?.value??'';const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)));return [...bytes].map(v=>v.toString(16).padStart(2,'0')).join('')!==old},oldHash,{timeout:45000});changed=true}catch{}
    const after=await ordinarySnapshot(args)
    return {scenario:'alice-created',actor:'alice',rotationRequested:true,changed:changed&&after.shareUrlSha256!==oldHash,oldShareUrlSha256:oldHash,newShareUrlSha256:after.shareUrlSha256}
  }
  if(step==='ordinary-host-remove') {
    if(ordinaryScenario(args)!=='keeper-created')throw new Error('Host removal belongs only to keeper-created scenario')
    const participant=expectedPubkey(args.expectedParticipantPubkey), name=boundedOrdinaryText(args.expectedParticipantName,64,'participant name')
    const before=await ordinarySnapshot(args)
    if(!before.roomOpen||before.roomTitleSha256!==expectedHash(args.expectedRoomTitleSha256,'room title'))throw new Error('Actual room does not match removal target')
    await page.locator('#roomIdentity').click()
    await page.locator('#roomSheet').waitFor({state:'visible'})
    if(!await page.locator('#hostPanel').isVisible())throw new Error('Actual account has no Host panel')
    if(!await page.locator('#hostPanel').evaluate(e=>e.open))await page.locator('#hostPanel > summary').click()
    const match=await page.evaluate(({participant,name})=>{
      const roster=[...document.querySelectorAll('#sheetRoster [data-participant]')]
      const target=roster.find(row=>row.dataset.participant===participant)
      const names=roster.filter(row=>row.querySelector('.rosterIdentity .name')?.textContent===name)
      const hosts=[...document.querySelectorAll('#hostList .hostRow')]
      const candidates=hosts.map((row,index)=>({row,index})).filter(({row})=>row.querySelector('.who .name')?.textContent===name&&[...row.querySelectorAll('button')].some(b=>b.textContent==='Remove'))
      return {rosterMatched:target?.querySelector('.rosterIdentity .name')?.textContent===name,uniqueRosterName:names.length===1,hostMatches:candidates.length,hostIndex:candidates[0]?.index}
    },{participant,name})
    if(!match.rosterMatched||!match.uniqueRosterName||match.hostMatches!==1)throw new Error('Host row cannot be bound uniquely to expected participant')
    await page.locator('#hostList .hostRow').nth(match.hostIndex).getByRole('button',{name:'Remove',exact:true}).click()
    const title=await page.locator('#actionTitle').textContent()
    if(!title?.startsWith(`Remove ${name}`)||await page.locator('#actionConfirm').textContent()!=='Remove from room')throw new Error('Unexpected host removal confirmation')
    await page.locator('#actionConfirm').click()
    let removedObserved=false
    try{await page.waitForFunction(pubkey=>![...document.querySelectorAll('#sheetRoster [data-participant]')].some(row=>row.dataset.participant===pubkey),participant,{timeout:30000});removedObserved=true}catch{}
    return {scenario:'keeper-created',actor:'alice',participantSha256:digest(participant),nameSha256:digest(name),removeRequested:true,removedObserved}
  }
  if(step==='ordinary-snapshot')return ordinarySnapshot(args)
  if(step==='open') return openPanel(args.panel)
  if(step==='refresh-preview-shell') {
    const result = await page.evaluate(async ({origin, scope}) => {
      const registration = await navigator.serviceWorker.getRegistration(scope)
      if (!registration) return { state: 'no-dev-worker' }
      const script = registration.active?.scriptURL ?? registration.waiting?.scriptURL ?? registration.installing?.scriptURL
      if (!script) throw new Error('Preview worker has no concrete script')
      const url = new URL(script)
      if (url.origin !== origin || url.pathname !== '/j/dev-sw.js' || registration.scope !== scope) throw new Error('Only this disposable Vite dev worker may be refreshed')
      if (!await registration.unregister()) throw new Error('Preview dev worker refresh refused')
      return { state: 'dev-worker-unregistered' }
    }, { origin: new URL(app).origin, scope: new URL('/j/', app).href })
    await page.goto('about:blank'); await page.goto(app)
    return { ...result, protectedStorageUntouched: true }
  }
  if(step==='navigate') {await page.goto(app);return {navigated:true}}
  if(step==='reload') {await page.reload();return {reloaded:true}}
  if(step==='enrol-device') {await page.locator('#mlsWitnessVaultRead').click();await page.locator('#mlsWitnessDeviceNew').waitFor({state:'visible',timeout:60000});await page.locator('#mlsWitnessDeviceNew').click();return {awaitingConfirmation:true}}
  if(step==='approve-action') {
    const text=await page.locator('#actionDescription').textContent();if(!args.expected?.length || !args.expected.every(v=>text.includes(v))) throw new Error('Unexpected app action confirmation')
    await page.locator('#actionConfirm').click();return {approved:true}
  }
  if(step==='approve-room') {
    const text=await page.locator('#mlsRoomConsent').textContent();if(!args.expected?.length || !args.expected.every(v=>text.includes(v))) throw new Error('Unexpected room permission confirmation')
    await page.locator('#mlsRoomConsent [data-approve]').click();return {approved:true}
  }
  if(step==='deny-bark') { const p=context.pages().find(p=>p.url().startsWith(`chrome-extension://${extension}/approve.html`));if(!p)throw new Error('No Bark request');await p.locator('#deny-btn').click();return {denied:true} }
  if(step==='approve-bark') {
    if(args.trust)throw new Error('Persistent site trust is outside this lab controller')
    const persona=args.expected?.persona
    if(typeof persona!=='string'||!/^[a-z0-9_-]{1,32}$/.test(persona))throw new Error('Named independent Bark persona required')
    const pinResponse=await fetch(control+'/private/signer?persona='+encodeURIComponent(persona))
    if(!pinResponse.ok)throw new Error('Independent Bark public pin unavailable')
    const pin=await pinResponse.json()
    if(pin.rootPub!==args.expected.pubkey)throw new Error('Independent Bark public pin mismatch')
    for(const approval of context.pages().filter(p=>p.url().startsWith(`chrome-extension://${extension}/approve.html`))) {
      if(!await approval.locator('#allow-btn').isEnabled().catch(()=>false))continue
      const details=await approvalDetails(approval)
      if(/(?:encrypt|decrypt)/i.test(details?.method??''))continue
      checkApproval(details,args.expected)
      await approval.locator('#allow-btn').click()
      return {approved:true,method:details.method,requestSha256:args.expected.sha256,allowOnce:true}
    }
    throw new Error('No matching concrete Bark approval')
  }
  if(step==='bark-connection-check') {
    const cfg = await (await fetch(control + '/private/signer?persona=alice')).json()
    const p = context.pages().find(p => p.url() === `chrome-extension://${extension}/popup.html`) ?? await context.newPage()
    if (!p.url().startsWith(`chrome-extension://${extension}/`)) await p.goto(`chrome-extension://${extension}/diagnostic.html`)
    return p.evaluate(({expectedUri, expectedPublic, expectedNpub}) => new Promise(resolve => {
      chrome.storage.local.get(['instances','activeInstanceId'], state => {
        const selected = state.instances?.find(i => i.id === state.activeInstanceId)
        let targetMatches = false, secretMatches = false
        try { const a = new URL(selected?.bunkerUri), b = new URL(expectedUri); targetMatches = a.host === b.host; secretMatches = a.searchParams.get('secret') === b.searchParams.get('secret') } catch {}
        resolve({ selectedExists: !!selected, uriMatches: selected?.bunkerUri === expectedUri, targetMatches, secretMatches,
          instancePublicPinKnown: selected?.signingPubkey === expectedPublic || selected?.npub === expectedNpub || selected?.heartwoodIdentityPubkey === expectedPublic,
          instanceCount: state.instances?.length ?? 0 })
      })
    }), { expectedUri: cfg.bunkerUri, expectedPublic: cfg.rootPub, expectedNpub: npubEncode(cfg.rootPub) })
  }
  if(step==='bark-state') { const states=[];for(const p of context.pages().filter(p=>p.url()===`chrome-extension://${extension}/popup.html`))states.push({activeNpubSha256:digest(await p.locator('#active-npub').textContent()??''),status:await p.locator('#status-dot').getAttribute('class'),pairError:clean(await p.locator('#pair-error').textContent()),setup:await p.locator('#heartwood-address').isVisible(),add:await p.locator('#add-address').isVisible(),main:await p.locator('#main-screen').isVisible()});return states }
  if(step==='bark-review') { const reviews=[]; for(const p of context.pages().filter(p=>p.url().startsWith(`chrome-extension://${extension}/approve.html`))){
    const details=await approvalDetails(p).catch(()=>null)
    if(!details||!Number.isFinite(details.expiresAt)||details.expiresAt<=Date.now())continue
    const actual={method:details.method,origin:details.origin,pubkey:details.pubkey,event:details.event??null,provision:details.provision??null}
    reviews.push({actionable:await p.locator('#allow-btn').isEnabled().catch(()=>false),method:details.method,
      origin:endpointSummary(details.origin,knownOrigins),pubkeySha256:digest(details.pubkey??''),requestSha256:digest(JSON.stringify(stable(actual))),
      event:details.event?{kind:kindClass(details.event.kind),contentEmpty:details.event.content==='',contentSha256:digest(details.event.content??''),createdAt:details.event.created_at,
        tagClasses:Array.isArray(details.event.tags)?details.event.tags.map(t=>fieldClass(t[0])):[],tagsSha256:digest(JSON.stringify(details.event.tags??[]))}:undefined,
      provision:details.provision?{keyClasses:Object.keys(details.provision).sort().map(k=>['v','expectedPersona','targetDevice','index','expiresAt','nonce'].includes(k)?k:'other'),sha256:digest(JSON.stringify(stable(details.provision)))}:undefined})
  }return reviews }
  if(step==='ui-labels') return page.locator('button:visible').allTextContents()
  if(step==='ui-state') return {visibility:await page.evaluate(()=>document.visibilityState),roomVisible:await page.locator('#mlsRoomDevelopment').isVisible(),startup:await page.locator('html').getAttribute('data-ordinary-startup'),startupFailure:await page.evaluate(()=>window.__mixedStartupFailure ?? null).then(v=>v?{name:v.name,message:clean(v.message,'app-startup')}:null),ordinaryDoor:await ordinaryDoorDiagnostics(),accountVisible:await page.locator('#mlsWitnessSettings').isVisible(),deviceReady:await page.locator('#mlsWitnessDevice').evaluateAll(es=>es.some(e=>e.textContent?.includes('Credential:'))),action:await page.locator('#actionDialog').isVisible(),roomConsent:await page.locator('#mlsRoomConsent').isVisible(),barkApproval:context.pages().some(p=>p.url().includes('/approve.html')),pageErrors:failures,diagnostics,diagnosticsOverflow}
  if(step==='observe-start') {
    if(args.adminRoles !== undefined && labProfile !== 'InvitationAdmins2') throw new Error('Admin policy observation requires the Admin2 lab')
    const selected = args.needles ?? []
    if(!Array.isArray(selected)) throw new Error('Prospective needles must be an array')
    return startWindow(args.name,[...selected,...(args.adminRoles === undefined ? [] : adminPolicyNeedles(args.adminRoles))])
  }
  if(step==='public-control') {
    if(page.url()==='about:blank')throw new Error('Navigate actual app before public positive control')
    const before=observations.length
    const id=`metadata-control-${randomUUID()}`
    controlSubscription=id
    let result
    try { result=await page.evaluate(({url,id})=>new Promise((resolve,reject)=>{
      const socket=new WebSocket(url)
      const timeout=setTimeout(()=>{socket.close();reject(new Error('Public relay control timed out'))},8000)
      socket.onopen=()=>socket.send(JSON.stringify(['REQ',id,{kinds:[1],limit:1}]))
      socket.onmessage=e=>{try{const v=JSON.parse(e.data);if(v[0]==='EOSE'&&v[1]===id){clearTimeout(timeout);socket.send(JSON.stringify(['CLOSE',id]));socket.close();resolve({opened:true,eose:true})}}catch{}}
      socket.onerror=()=>{clearTimeout(timeout);reject(new Error('Public relay control socket failed'))}
    }),{url:runtimeConfig.publicRelay,id}) } catch(error) { controlSubscription=undefined;throw error }
    for(let i=0;i<20&&!observations.slice(before).some(o=>o.control==='CLOSE');i++)await page.waitForTimeout(50)
    const related=observations.slice(before).filter(o=>o.source==='app-websocket'&&o.originSha256===digest(new URL(runtimeConfig.publicRelay).origin)&&o.subscriptionSha256===digest(id))
    const sent=related.some(o=>o.control==='REQ'),closed=related.some(o=>o.control==='CLOSE')
    controlSubscription=undefined
    publicControl={...result,subscriptionSha256:digest(id),outboundObserved:sent,closeObserved:closed}
    if(!sent||!closed)throw new Error('Exact public positive control REQ/CLOSE was not observed outbound')
    return publicControl
  }
  if(step==='observe-audit') {assertProspectiveNeedles(args.needles,needles);return auditWindow()}
  if(step==='observe') return {window:auditWindow(),closedWindows,blockedNetworkAttempts,pageErrors:failures,observations}
  if(step==='witness-enrol') {
    const state=await page.evaluate(()=>window.__mixedInvitationLab.step('account-state'))
    const e=state.enrolment;if(e.state!=='genesis')throw new Error('Actual account has no genesis')
    const r=await fetch(control+'/private/fixture',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({path:'/witness/enrol',body:{subject:e.subject,installation:e.installation,writer:e.writer,initial_digest:e.digest}})});if(!r.ok)throw new Error('Witness keeper enrolment refused');return {enrolled:true}
  }
  await requireLabProfile()
  return page.evaluate(({step,args})=>window.__mixedInvitationLab.step(step,args),{step,args})
}
const sideSteps=new Set(['approve-action','approve-room','approve-bark','deny-bark','ui-state','ui-labels','bark-review','bark-state','bark-connection-check','observe','observe-audit','public-control','signin-inline','ordinary-public-context','lab-profile'])
const server=createServer(async(req,res)=>{
  res.setHeader('content-type','application/json');
  res.setHeader('cache-control','no-store');
  try {
    if(req.method==='GET'&&req.url==='/private/bark-approval'){
      if(req.socket.remoteAddress!=='127.0.0.1'&&req.socket.remoteAddress!=='::ffff:127.0.0.1'){res.writeHead(403).end('{}');return}
      let dto
      for(const approval of context.pages().filter(p=>p.url().startsWith(`chrome-extension://${extension}/approve.html`))){
        if(!await approval.locator('#allow-btn').isEnabled().catch(()=>false))continue
        const details=await approvalDetails(approval).catch(()=>null)
        dto=permittedApprovalDto(details,new URL(app).origin)
        if(dto)break
      }
      res.end(JSON.stringify(dto??null));return
    }
    if(req.method==='GET'&&req.url==='/private/ordinary-share'){
      if(req.socket.remoteAddress!=='127.0.0.1'&&req.socket.remoteAddress!=='::ffff:127.0.0.1'){res.writeHead(403).end('{}');return}
      if(active){res.writeHead(409).end('{}');return}
      if(!await page.locator('#roomArea').isVisible()){res.writeHead(409).end('{}');return}
      const url=await page.locator('#shareUrl').inputValue()
      if(typeof url!=='string'||Buffer.byteLength(url)>8192){res.writeHead(409).end('{}');return}
      const parsed=new URL(url)
      if(parsed.origin!==new URL(app).origin||parsed.pathname!=='/j/'||!parsed.hash){res.writeHead(409).end('{}');return}
      res.end(JSON.stringify({url,sha256:digest(url)}));return
    }
    if(req.url==='/result'){res.end(JSON.stringify({active,result}));return}
    if(req.url==='/state'){res.end(JSON.stringify({active,complete:!!result,failures}));return}
    if(req.method!=='POST'||req.url!=='/step'){res.writeHead(404).end('{}');return}
    let body='';for await(const chunk of req){body+=chunk;if(body.length>4*1024*1024)throw new Error('Bounded command required')}
    const {step,args={}}=JSON.parse(body)
    if(sideSteps.has(step)){const v=await run(step,args);res.end(JSON.stringify({ok:true,result:v}));return}
    if(active){res.writeHead(409).end(JSON.stringify({ok:false,error:'Browser operation still active'}));return}
    active=step;result=undefined
    activePrivateTerms=typeof step==='string'&&step.startsWith('ordinary-')&&args&&typeof args==='object'?['name','displayName','body','url'].map(key=>args[key]).filter(value=>typeof value==='string'&&value.length>0&&value.length<=8192):[]
    void run(step,args).then(value=>{result={step,ok:true,result:value}},error=>{result={step,ok:false,error:'Named browser operation refused',diagnostic:clean(error)};failures++}).finally(()=>{active=undefined;activePrivateTerms=[]})
    res.end(JSON.stringify({queued:true,step}))
  }catch{res.writeHead(400).end(JSON.stringify({ok:false,error:'Browser controller refused command'}))}
})
server.listen(28446,'127.0.0.1',()=>console.log('Mixed browser private controller ready on loopback port 28446'))
async function close(){server.close();await context.close();process.exit(0)}
process.on('SIGTERM',()=>void close());process.on('SIGINT',()=>void close())
