// Faults at the built app's platform boundaries, without a production test API.
// Only the disposable fixture's consent is observed; it is never logged.
export async function installRoomFaults(context) {
  await context.addInitScript(() => {
    let latest
    const remember = data => {
      const entries = JSON.parse(new TextDecoder().decode(data))
      latest = entries.at(-1)
      window.roomFaultPlan = latest
    }
    const isConsent = algorithm => algorithm?.additionalData && new TextDecoder().decode(algorithm.additionalData) === 'kithmoot.browser-room-consent.v1'
    const pause = async (point, consent) => {
      const fault = window.roomFault
      if (!fault || fault.point !== point || fault.phase !== consent?.phase) return
      fault.hit = true
      fault.consent = consent
      await new Promise(() => {}) // The test closes this tab, as a crash would.
    }
    const encrypt = crypto.subtle.encrypt.bind(crypto.subtle)
    crypto.subtle.encrypt = async (algorithm, key, data) => {
      if (isConsent(algorithm)) {
        remember(data)
        // active/retired is saved only after all server acknowledgements.
        await pause('after-ack', latest)
      }
      return encrypt(algorithm, key, data)
    }
    const decrypt = crypto.subtle.decrypt.bind(crypto.subtle)
    crypto.subtle.decrypt = async (algorithm, key, data) => {
      const plain = await decrypt(algorithm, key, data)
      if (isConsent(algorithm)) remember(plain)
      return plain
    }
    const request = navigator.locks.request.bind(navigator.locks)
    navigator.locks.request = async (name, options, callback) => {
      if (name.startsWith('kithmoot.room-public.') && options?.mode === 'exclusive') {
        // The encrypted pending intent has committed before this barrier.
        // No grant publication can begin until its callback runs.
        await pause('before-publish', latest)
      }
      return typeof options === 'function' ? request(name, options) : request(name, options, callback)
    }
  })
}

export async function armRoomFault(page, phase, point) {
  await page.evaluate(({phase, point}) => { window.roomFault = {phase, point, hit:false} }, {phase, point})
  if(point==='lost-first-ok')await page.evaluate(async()=>{
    const manifest=await(await fetch('./link-web/manifest.json')).json()
    const {LinkEngine}=await import(`./link-web/link_web.js?v=${manifest.sourceCommit}`)
    const open=LinkEngine.prototype.openSocket
    LinkEngine.prototype.openSocket=function(url,route,listener){
      return open.call(this,url,route,{...listener,onText:text=>{
        const frame=JSON.parse(text), fault=window.roomFault, consent=window.roomFaultPlan
        const statement=consent?.phase==='withdrawing'?'revoked':'active'
        if(fault?.point==='lost-first-ok' && consent?.phase===fault.phase && frame[0]==='OK' && frame[2]===true && consent.grants.some(g=>g[statement].id===frame[1])){
          fault.hit=true;fault.consent=consent
          return // The real server accepted this event; the app never sees its OK.
        }
        listener.onText?.(text)
      }})
    }
  })
}

export async function waitRoomFault(page) {
  await page.waitForFunction(() => window.roomFault?.hit, undefined, {timeout:120_000})
  return page.evaluate(() => window.roomFault.consent)
}
