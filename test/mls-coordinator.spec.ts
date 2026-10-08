import { test, expect } from '@playwright/test'
import { build } from 'esbuild'
import { readFileSync } from 'node:fs'
const origin='https://browser-mls.kithmoot.test'
let bundle:string
test.beforeAll(async()=>{
  bundle=(await build({entryPoints:['test/mls-coordinator.browser-entry.ts'],bundle:true,write:false,format:'iife',globalName:'M',
    define:{'import.meta.env.BASE_URL':'"/"'}})).outputFiles[0].text
})
test('pinned Rust coordinator promotes a witnessed candidate after a lost response and fences a restored copy',async({browser})=>{
  const context=await browser.newContext()
  try{
    await context.route(origin+'/**',route=>{
      const path=new URL(route.request().url()).pathname
      if(path==='/')return route.fulfill({contentType:'text/html',headers:{'Content-Security-Policy':"default-src 'self'; script-src 'self' 'wasm-unsafe-eval'"},body:'<script src="/fixture.js"></script>'})
      if(path==='/fixture.js')return route.fulfill({contentType:'text/javascript',body:bundle})
      if(path==='/vmls-wasm/vmls_wasm.js' || path==='/vmls-wasm/vmls_wasm_bg.wasm')return route.fulfill({contentType:path.endsWith('.wasm')?'application/wasm':'text/javascript',body:readFileSync('app/public'+path)})
      return route.abort()
    })
    const page=await context.newPage(), errors:string[]=[]
    page.on('pageerror',e=>errors.push(e.message))
    await page.goto(origin)
    expect(await page.evaluate('M.run()')).toEqual({initial:'active',held:'held',decision:'promote',generation:'2',fenced:{type:'fenced',reason:'witness-mismatch'},offline:'held',confirmed:false})
    expect(errors).toEqual([])
  }finally{await context.close()}
})
