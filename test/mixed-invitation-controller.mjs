import { npubEncode } from 'nostr-tools/nip19'
import { wireMatches } from './mixed-invitation-wire-audit.mjs'
import { chromium } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'

const app = 'http://localhost:28445/j/'
const control = 'http://127.0.0.1:28440'
const bark = path.resolve('../bark-mixed-invitation-20261025/dist')
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
// Match only forbidden destinations. Selected ownstack sockets are wholly
// native: they never enter a Playwright socket route or proxy.
await context.routeWebSocket(url => !allowedNetworkOrigins.has(url.origin), socket => {
  const u = new URL(socket.url())
  blockedNetworkAttempts.push({ kind: 'websocket', origin: u.origin, path: u.pathname })
  socket.close({ code: 1008, reason: 'Disposable ownstack lab allows only its explicitly selected relays' })
})
await context.route('**/*', route => { const u=new URL(route.request().url());if(route.request().url().startsWith(`chrome-extension://${extension}/`) || allowedNetworkOrigins.has(u.origin))return route.continue();blockedNetworkAttempts.push({kind:'request',origin:u.origin,path:u.pathname});return route.abort('blockedbyclient') })
const page = await context.newPage()
let active, result, failures = 0, observe = false, needles = [], observations = [], violations = 0, privateObservedFrames = [], observedBytes = 0, observerOverflow = false
const digest = v => createHash('sha256').update(v).digest('hex')

function endpointOf(url) { try { const u=new URL(url); return { origin:u.origin, path:u.pathname } } catch { return undefined } }
function frame(payload, source, endpoint) {
  if (!observe) return
  const wire = Buffer.from(payload), raw = wire.toString('utf8')
  if (observedBytes + wire.length <= 16 * 1024 * 1024) { privateObservedFrames.push({wire,source,endpoint}); observedBytes += wire.length } else observerOverflow = true
  for (const needle of needles) if (wireMatches(wire, needle)) violations++
  let type = 'opaque', kind, tags
  try { const value = JSON.parse(raw); if (Array.isArray(value)) { type = value[0]; const e = value.find(v => v && typeof v === 'object' && Number.isInteger(v.kind)); if (e) { kind=e.kind; tags=e.tags?.map(t=>t[0]) } } } catch {}
  observations.push({ source, ...(endpoint??{endpointUnknown:true}), type, kind, tags, length: wire.length, sha256: digest(wire) })
}
page.on('websocket', socket => { socket.on('framesent', e => frame(e.payload, 'app-websocket', endpointOf(socket.url()))); socket.on('socketerror', () => failures++) })
page.on('request', request => { if (!observe) return; const u=new URL(request.url()); observations.push({ source:'request', method:request.method(), origin:u.origin, path:u.pathname, length:request.postDataBuffer()?.length ?? 0 }); if(request.postData()) for(const n of needles) if(n && request.postData().includes(n)) violations++ })
const diagnostics=[]
const clean = e => String(e?.message ?? e).replace(/(?:bunker|bothy|nostrconnect):[^\s]+/g,'[private capability]').replace(/[0-9a-f]{64,}/g,'[identifier]').slice(0,1000)
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
    return {configured:true,publicProfiles:false,nip05:false,defaultRelay:runtimeConfig.publicRelay,blockedAttemptsBeforeConfiguration:blockedNetworkAttempts.length}
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
    await popup.close();return {paired:true,persona:cfg.rootPub,independentPublicPinMatched:true}
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
    let approval;for(const candidate of context.pages().filter(p=>p.url().startsWith(`chrome-extension://${extension}/approve.html`))){if(!await candidate.locator('#allow-btn').isEnabled().catch(()=>false))continue;const title=(await candidate.locator('#title').textContent())?.trim()??'';if(/^(?:Encrypt|Decrypt)\b/i.test(title))continue;const text=await candidate.locator('body').textContent();if(args.expected?.length && args.expected.every(v=>text.includes(v))){approval=candidate;break}}if(!approval) throw new Error('No matching concrete Bark approval')
    await approval.locator('#origin-text').waitFor();const origin=await approval.locator('#origin-text').textContent();if(!origin.includes(new URL(app).origin)) throw new Error('Unexpected Bark origin')
    if(args.expected){const text=await approval.locator('body').textContent();if(!args.expected.every(v=>text.includes(v)))throw new Error('Unexpected Bark request')}
    if(args.trust)throw new Error('Persistent site trust is outside this lab controller');await approval.locator('#allow-btn').click();return {approved:true}
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
  if(step==='bark-state') { const states=[];for(const p of context.pages().filter(p=>p.url()===`chrome-extension://${extension}/popup.html`))states.push({activeNpub:await p.locator('#active-npub').textContent(),status:await p.locator('#status-dot').getAttribute('class'),pairError:clean(await p.locator('#pair-error').textContent()),setup:await p.locator('#heartwood-address').isVisible(),add:await p.locator('#add-address').isVisible(),main:await p.locator('#main-screen').isVisible()});return states }
  if(step==='bark-review') { const reviews=[]; for(const p of context.pages().filter(p=>p.url().startsWith(`chrome-extension://${extension}/approve.html`))){let kind,publicBinding;try{const e=JSON.parse(await p.locator('#event-json').textContent());kind=e.kind;if([20460,22242,24242].includes(kind))publicBinding={kind,contentEmpty:e.content==='',createdAt:e.created_at,tags:e.tags}}catch{} let provision;try{const v=JSON.parse(await p.locator('#request-content').textContent());if(v.v===1&&typeof v.expectedPersona==='string'&&typeof v.targetDevice==='string'&&Number.isInteger(v.index))provision={v:v.v,expectedPersona:v.expectedPersona,targetDevice:v.targetDevice,index:v.index,expiresAt:v.expiresAt,nonceSha256:digest(v.nonce)}}catch{} reviews.push({actionable:await p.locator('#allow-btn').isEnabled().catch(()=>false),title:await p.locator('#title').textContent(),origin:await p.locator('#origin-text').textContent(),kind,publicBinding,provision})}return reviews }
  if(step==='ui-labels') return page.locator('button:visible').allTextContents()
  if(step==='ui-state') return {startup:await page.locator('html').getAttribute('data-ordinary-startup'),startupFailure:await page.evaluate(()=>window.__mixedStartupFailure ?? null).then(v=>v?{name:v.name,message:clean(v.message)}:null),accountVisible:await page.locator('#mlsWitnessSettings').isVisible(),deviceReady:await page.locator('#mlsWitnessDevice').evaluateAll(es=>es.some(e=>e.textContent?.includes('Credential:'))),action:await page.locator('#actionDialog').isVisible(),roomConsent:await page.locator('#mlsRoomConsent').isVisible(),barkApproval:context.pages().some(p=>p.url().includes('/approve.html')),pageErrors:failures,diagnostics}
  if(step==='observe-start') {observations=[];privateObservedFrames=[];observedBytes=0;observerOverflow=false;violations=0;needles=args.needles??[];observe=true;return {started:true}}
  if(step==='observe-audit') {
    const checked=args.needles??[];let matches=0,unattributedFrames=0;const endpoints={}
    for(const entry of privateObservedFrames) {
      if(!entry.endpoint)unattributedFrames++
      const key=entry.endpoint?`${entry.source} ${entry.endpoint.origin}${entry.endpoint.path}`:`${entry.source} [unattributed]`
      const count=endpoints[key]??={frames:0,matches:0};count.frames++
      for(const needle of checked)if(wireMatches(entry.wire,needle)){matches++;count.matches++}
    }
    return {workerCoverage,currentWorkerTargets:workerTargets.size,alive:privateObservedFrames.length>0,observerOverflow,frames:privateObservedFrames.length,unattributedFrames,endpoints,sourceCounts:observations.reduce((counts,o)=>(counts[o.source]=(counts[o.source]??0)+1,counts),{}),laterAuditCoverage:'websocket frames only; HTTP checks use needles active at request time',checkedNeedles:checked.length,matches,observationDigest:digest(JSON.stringify(observations))}
  }
  if(step==='observe') return {workerCoverage,currentWorkerTargets:workerTargets.size,blockedNetworkAttempts,observerOverflow,alive:observations.length>0,violations,pageErrors:failures,observations}
  if(step==='witness-enrol') {
    const state=await page.evaluate(()=>window.__mixedInvitationLab.step('account-state'))
    const e=state.enrolment;if(e.state!=='genesis')throw new Error('Actual account has no genesis')
    const r=await fetch(control+'/private/fixture',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({path:'/witness/enrol',body:{subject:e.subject,installation:e.installation,writer:e.writer,initial_digest:e.digest}})});if(!r.ok)throw new Error('Witness keeper enrolment refused');return {enrolled:true}
  }
  return page.evaluate(({step,args})=>window.__mixedInvitationLab.step(step,args),{step,args})
}
const sideSteps=new Set(['approve-action','approve-room','approve-bark','deny-bark','ui-state','ui-labels','bark-review','bark-state','bark-connection-check','observe','observe-audit'])
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
