// Visible built-app pairing, with a disposable extension signer and local Bothy.
import { chromium } from '@playwright/test'
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
const app = process.env.LINK_TEST_APP
const control = process.env.LINK_BOTHY_CONTROL
const relay = process.env.LINK_TEST_RELAY
if (!app || !['localhost','127.0.0.1'].includes(new URL(app).hostname) || !control || new URL(control).hostname !== '127.0.0.1' || !relay?.startsWith('wss://')) throw new Error('Set local LINK_TEST_APP, LINK_BOTHY_CONTROL and LINK_TEST_RELAY.')
const key = new Uint8Array(createHash('sha256').update('kithmoot-g5-fixture-signer-v2:alice').digest())
const browser = await chromium.launch({ args: [`--host-resolver-rules=MAP ${new URL(relay).hostname} 127.0.0.1`] })
const context = await browser.newContext({ignoreHTTPSErrors:true,serviceWorkers:'block',viewport:{width:390,height:844}})
try {
  await context.exposeFunction('fixturePublicKey',()=>getPublicKey(key))
  await context.exposeFunction('fixtureSign',e=>finalizeEvent(e,key))
  await context.addInitScript(()=>{window.nostr={getPublicKey:()=>window.fixturePublicKey(),signEvent:e=>window.fixtureSign(e)}})
  // Ordinary account/profile lookups are outside this pairing test and stay local.
  await context.routeWebSocket(url=>url.href!==relay,ws=>ws.close())
  const page=await context.newPage(), errors=[]
  page.on('pageerror',e=>errors.push(e.message))
  await page.goto(app+'?signin=nostr')
  await page.getByRole('button',{name:/Browser extension/}).click()
  const open=async()=>{
    await page.locator('#openAppSettings').click()
    if (!await page.locator('#bothySettingsOpen').isVisible()) await page.locator('#appConnections > summary').click()
    await page.locator('#bothySettingsOpen').click()
  }
  await open()
  await page.locator('#bothyRelays').fill(relay)
  await page.getByRole('button',{name:'Connect or resume',exact:true}).click()
  await page.getByText('Ready to pair. Paste a current code from your Bothy.',{exact:true}).waitFor()
  const {uri}=await(await fetch(control+'/pairing',{method:'POST'})).json()
  await page.locator('#bothyCode').fill(uri)
  await page.getByRole('button',{name:'Pair Bothy',exact:true}).click()
  await page.getByText('Bothy paired and saved on this browser. Room routing is not enabled yet.',{exact:true}).waitFor({timeout:120000})
  assert.equal(await page.locator('#bothyCode').inputValue(),'')
  await page.getByRole('button',{name:'Close connection',exact:true}).click()
  await page.getByText('Connection closed. The sealed pairing is kept for reconnecting.',{exact:true}).waitFor()
  await page.reload();await open()
  await page.getByRole('button',{name:'Connect or resume',exact:true}).click()
  await page.getByText('Connection resumed. 1 paired Bothy route available.',{exact:true}).waitFor()
  assert.equal(await page.locator('#bothySettings').evaluate(el=>el.scrollWidth<=el.clientWidth),true)
  if(process.env.LINK_TEST_SCREENSHOT) await page.screenshot({path:process.env.LINK_TEST_SCREENSHOT})
  assert.deepEqual(errors,[])
  console.log(JSON.stringify({visiblePairing:true,codeCleared:true,reloadResume:true,mobileLayout:true,pageErrors:0}))
} finally {key.fill(0);await context.close();await browser.close()}
