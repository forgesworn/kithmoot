import { npubEncode } from 'nostr-tools/nip19'
import { sha256, endpointSummary, frameSummary, httpSummary, matchesNeedleNow, withinBudget, assertProspectiveNeedles, windowTransition, keyClass, safeNumber } from './mixed-invitation-metadata-audit.mjs'
import { chromium } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

const app = 'http://localhost:28445/j/'
const control = 'http://127.0.0.1:28440'
const bark = path.resolve('.lab/bark-built-6c303065')
const profile = path.resolve('.lab/browser-profile')
await mkdir(profile, { recursive: true, mode: 0o700 })
const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
  args: ['--enable-unsafe-extension-debugging', `--disable-extensions-except=${bark}`, `--load-extension=${bark}`],
})
const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker')
const extension = new URL(worker.url()).host
const runtimeConfig = await (await fetch(control + '/private/config')).json()
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
const namedWindows = new Set(['bootstrap', 'ordinary', 'private', 'fault', 'reconnect', 'refusal'])
let active, result, failures = 0, observe = true, windowName = 'bootstrap', needles = [], observations = [], violations = 0
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
const clean = e => ({ name: /^(?:Error|TypeError|RangeError|AbortError|TimeoutError|NotAllowedError|InvalidStateError)$/.test(e?.name) ? e.name : 'Error', messageSha256:digest(String(e?.message??e)) })
page.on('pageerror', e => { failures++; diagnostics.push(clean(e)) })
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

async function settings() {
  for (let i=0;i<30;i++) { if(await page.locator('#settingsPane').isVisible()) break; await page.locator('#openAppSettings').evaluate(e=>e.click()); await page.waitForTimeout(100) }
  if(await page.locator('#settingsPane').getAttribute('data-page') !== 'main') await page.locator('#settingsBack').click()
  await page.locator('#settingsPane .infoRow').filter({has:page.locator('.infoRowTitle',{hasText:/^Connections$/})}).click()
}
async function openPanel(kind) {
  for(const id of ['#mlsWitnessSettings','#mlsRoomDevelopment','#mlsGrantDevelopment']) if(await page.locator(id).isVisible()) {
    const close=id==='#mlsWitnessSettings' ? page.locator('#mlsWitnessClose') : page.locator(id+' [data-close]'); await close.click()
  }
  await settings()
  const ids={account:'mlsWitnessSettingsOpen',room:'mlsRoomDevelopmentOpen',grant:'mlsGrantDevelopmentOpen'}
  await page.locator('#'+ids[kind]).click()
  await page.waitForFunction(kind=>window.__mixedInvitationLab?.ready()[kind==='room'?'rooms':kind==='grant'?'grants':'account'],kind)
  return {opened:kind}
}
async function run(step,args) {
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
    const details=await approvalDetails(p)
    const actual={method:details.method,origin:details.origin,pubkey:details.pubkey,event:details.event??null,provision:details.provision??null}
    reviews.push({actionable:await p.locator('#allow-btn').isEnabled().catch(()=>false),method:details.method,
      origin:endpointSummary(details.origin,knownOrigins),pubkeySha256:digest(details.pubkey??''),requestSha256:digest(JSON.stringify(stable(actual))),
      event:details.event?{kind:kindClass(details.event.kind),contentEmpty:details.event.content==='',contentSha256:digest(details.event.content??''),createdAt:details.event.created_at,
        tagClasses:Array.isArray(details.event.tags)?details.event.tags.map(t=>fieldClass(t[0])):[],tagsSha256:digest(JSON.stringify(details.event.tags??[]))}:undefined,
      provision:details.provision?{keyClasses:Object.keys(details.provision).sort().map(k=>['v','expectedPersona','targetDevice','index','expiresAt','nonce'].includes(k)?k:'other'),sha256:digest(JSON.stringify(stable(details.provision)))}:undefined})
  }return reviews }
  if(step==='ui-labels') return page.locator('button:visible').allTextContents()
  if(step==='ui-state') return {startup:await page.locator('html').getAttribute('data-ordinary-startup'),startupFailure:await page.evaluate(()=>window.__mixedStartupFailure ?? null).then(v=>v?{name:v.name,message:clean(v.message)}:null),accountVisible:await page.locator('#mlsWitnessSettings').isVisible(),deviceReady:await page.locator('#mlsWitnessDevice').evaluateAll(es=>es.some(e=>e.textContent?.includes('Credential:'))),action:await page.locator('#actionDialog').isVisible(),roomConsent:await page.locator('#mlsRoomConsent').isVisible(),barkApproval:context.pages().some(p=>p.url().includes('/approve.html')),pageErrors:failures,diagnostics}
  if(step==='observe-start') return startWindow(args.name,args.needles??[])
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
  return page.evaluate(({step,args})=>window.__mixedInvitationLab.step(step,args),{step,args})
}
const sideSteps=new Set(['approve-action','approve-room','approve-bark','deny-bark','ui-state','ui-labels','bark-review','bark-state','bark-connection-check','observe','observe-audit','public-control'])
const server=createServer(async(req,res)=>{
  res.setHeader('content-type','application/json');
  try {
    if(req.url==='/result'){res.end(JSON.stringify({active,result}));return}
    if(req.url==='/state'){res.end(JSON.stringify({active,complete:!!result,failures}));return}
    if(req.method!=='POST'||req.url!=='/step'){res.writeHead(404).end('{}');return}
    let body='';for await(const chunk of req){body+=chunk;if(body.length>4*1024*1024)throw new Error('Bounded command required')}
    const {step,args={}}=JSON.parse(body)
    if(sideSteps.has(step)){const v=await run(step,args);res.end(JSON.stringify({ok:true,result:v}));return}
    if(active){res.writeHead(409).end(JSON.stringify({ok:false,error:'Browser operation still active'}));return}
    active=step;result=undefined
    void run(step,args).then(value=>{result={step,ok:true,result:value}},error=>{result={step,ok:false,error:'Named browser operation refused',diagnostic:clean(error)};failures++}).finally(()=>{active=undefined})
    res.end(JSON.stringify({queued:true,step}))
  }catch{res.writeHead(400).end(JSON.stringify({ok:false,error:'Browser controller refused command'}))}
})
server.listen(28446,'127.0.0.1',()=>console.log('Mixed browser private controller ready on loopback port 28446'))
async function close(){server.close();await context.close();process.exit(0)}
process.on('SIGTERM',()=>void close());process.on('SIGINT',()=>void close())
