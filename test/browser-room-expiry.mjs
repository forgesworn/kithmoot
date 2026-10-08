import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {finalizeEvent,getPublicKey} from 'nostr-tools/pure'

export async function expiryBundle() {
  return (await build({entryPoints:['test/browser-link.browser-entry.ts'],bundle:true,write:false,
    format:'iife',globalName:'L',target:'es2022',define:{'import.meta.env.BASE_URL':'"/j/"'}})).outputFiles[0].text
}

export async function grantRows(control,scopes,issuer) {
  const rows=[]
  for(const room of scopes){
    const response=await fetch(control+'/room-grants',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({room,issuer})})
    assert(response.ok,'read-only fixture grant oracle must succeed')
    rows.push(...(await response.json()).grants)
  }
  return rows.sort((a,b)=>a.id.localeCompare(b.id))
}

// The product's 30-day default is untouched. A separate disposable keeper
// installs shorter, valid signed terms through the actual paired Link/NIP-42
// carrier. Bothy then expires them on its unmodified wall clock.
export async function shortenGrants({browser,app,control,linkRelay,ownerKey,grants}) {
  assert(grants.length>0)
  const context=await browser.newContext()
  try {
    const page=await context.newPage()
    await page.exposeFunction('fixtureSign',template=>finalizeEvent(template,ownerKey))
    await page.goto(app+'__expiry.html')
    await page.evaluate(async ({account,relay})=>{
      window.identity={pubkey:account,signEvent:template=>window.fixtureSign(template)}
      window.link=new L.BrowserLink(L.startBrowserLink)
      await link.resume(account,[relay])
    },{account:getPublicKey(ownerKey),relay:linkRelay})
    const response=await fetch(control+'/pairing',{method:'POST'});assert(response.ok)
    await page.evaluate(code=>link.pair(code),(await response.json()).uri)
    const at=Math.max(Math.floor(Date.now()/1000),...grants.map(g=>g.created_at+1)), expires=at+20
    const short=grants.map(g=>finalizeEvent({kind:g.kind,content:g.content,created_at:at,
      tags:g.tags.map(t=>t[0]==='expiration'?['expiration',String(expires)]:t)},ownerKey))
    await page.evaluate(async events=>{
      for(const event of events){
        const pool=new L.BrowserLinkRelay(link,link.boxes()[0],identity,{room:event.tags.find(t=>t[0]==='d')[1],kinds:[24242]})
        try{await pool.publish(event)}finally{pool.close()}
      }
      await link.stop()
    },short)
    return expires
  } finally {await context.close()}
}
