import { build } from 'esbuild'
import { expect, test } from '@playwright/test'

const ORIGIN='https://ordinary-startup-resource.test'
let bundle=''
test.beforeAll(async()=>{
  bundle=(await build({entryPoints:['app/src/ordinary-legacy-startup.ts'],bundle:true,write:false,
    format:'iife',globalName:'StartupResource',platform:'browser',target:'es2022'})).outputFiles[0]!.text
})
test.beforeEach(async({page})=>{
  await page.route(ORIGIN+'/**',route=>route.fulfill({contentType:'text/html',
    body:`<!doctype html><script>${bundle.replace(/<\/script/gi,'<\\/script')}</script>`}))
  await page.goto(ORIGIN)
  await page.evaluate(`(()=>{
    window.lifetime=new StartupResource.OrdinaryLegacyStartupLifetime()
    window.nameOfDatabase='kithmoot-ordinary-state-v1'
    window.probe=kind=>navigator.locks.request(nameOfDatabase+':'+kind,{ifAvailable:true},lock=>!!lock)
    window.seed=()=>new Promise((yes,no)=>{const r=indexedDB.open(nameOfDatabase,1);
      r.onupgradeneeded=()=>r.result.createObjectStore('owners');r.onerror=()=>no(r.error);
      r.onsuccess=()=>{r.result.close();yes()}})
    window.effects={entropy:0,reads:0,writes:0}
    crypto.getRandomValues=()=>{effects.entropy++;throw Error('startup entropy')}
    Storage.prototype.getItem=()=>{effects.reads++;throw Error('startup storage read')}
    Storage.prototype.setItem=()=>{effects.writes++;throw Error('startup storage write')}
  })()`)
})

test('startup resource proves absence without storage effects and holds both leases until close',async({page})=>{
  expect(await page.evaluate(`(async()=>{
    await lifetime.acquire();const presence=await lifetime.inspectPresence()
    let refused=false;try{await lifetime.releaseInitialWrite()}catch{refused=true}
    const before=[await probe('migration'),await probe('write')]
    await lifetime.close()
    return {presence,refused,before,after:[await probe('migration'),await probe('write')],effects,
      absent:!(await indexedDB.databases()).some(row=>row.name===nameOfDatabase)}
  })()`)).toEqual({presence:'absent',refused:true,before:[false,false],after:[true,true],
    effects:{entropy:0,reads:0,writes:0},absent:true})
})

test('startup resource hands WRITE to a queued native capture while retaining MIGRATION',async({page})=>{
  expect(await page.evaluate(`(async()=>{
    await seed();await lifetime.acquire();const presence=await lifetime.inspectPresence()
    let started=false,release
    const capture=navigator.locks.request(nameOfDatabase+':write',async()=>{
      started=true;await new Promise(resolve=>release=resolve)
    })
    const queued=started;await lifetime.releaseInitialWrite()
    // This queued shared request is ordered after the already queued capture.
    const held=await navigator.locks.request(nameOfDatabase+':write',{ifAvailable:true},lock=>!!lock)
    const migration=await probe('migration')
    let repeated=false,legacy=false
    try{await lifetime.releaseInitialWrite()}catch{repeated=true}
    try{lifetime.commitLegacy()}catch{legacy=true}
    release();await capture;await lifetime.close()
    return {presence,queued,started,held,migration,repeated,legacy,
      after:[await probe('migration'),await probe('write')],effects}
  })()`)).toEqual({presence:'existing',queued:false,started:true,held:false,migration:false,
    repeated:true,legacy:true,after:[true,true],effects:{entropy:0,reads:0,writes:0}})
})

test('startup resource refuses WRITE handoff before a successful presence decision',async({page})=>{
  expect(await page.evaluate(`(async()=>{
    await lifetime.acquire();let before=false,failed=false,after=false
    try{await lifetime.releaseInitialWrite()}catch{before=true}
    const native=indexedDB.open.bind(indexedDB)
    indexedDB.open=()=>{throw new DOMException('unavailable','UnknownError')}
    try{await lifetime.inspectPresence()}catch{failed=true}
    indexedDB.open=native
    try{await lifetime.releaseInitialWrite()}catch{after=true}
    const held=[await probe('migration'),await probe('write')];await lifetime.close()
    return {before,failed,after,held,released:[await probe('migration'),await probe('write')]}
  })()`)).toEqual({before:true,failed:true,after:true,held:[false,false],released:[true,true]})
})

test('startup resource joins a delayed actual native open success before releasing either lease',async({page})=>{
  await page.evaluate(`(async()=>{
    await seed();await lifetime.acquire();const native=indexedDB.open.bind(indexedDB)
    indexedDB.open=(...args)=>{
      const request=native(...args)
      return new Proxy(request,{
        get(target,name){const value=Reflect.get(target,name,target);return typeof value==='function'?value.bind(target):value},
        set(target,name,value){
          if(name==='onsuccess'){target.onsuccess=event=>{window.deliver=()=>value.call(target,event);window.ready=true};return true}
          return Reflect.set(target,name,value,target)
        }
      })
    }
    window.decision='pending';window.resourceClosed=false
    window.pending=lifetime.inspectPresence().then(value=>decision=value,()=>decision='held')
    window.restore=()=>indexedDB.open=native
  })()`)
  await page.waitForFunction('window.ready')
  expect(await page.evaluate(`(async()=>{
    window.closing=lifetime.close().then(()=>resourceClosed=true)
    return {decision,closed:resourceClosed,locks:[await probe('migration'),await probe('write')]}
  })()`)).toEqual({decision:'pending',closed:false,locks:[false,false]})
  expect(await page.evaluate(`(async()=>{
    deliver();await pending;await closing;restore()
    const upgraded=await new Promise((yes,no)=>{const r=indexedDB.open(nameOfDatabase,2);
      r.onerror=()=>no(r.error);r.onblocked=()=>no(Error('late connection leaked'));
      r.onsuccess=()=>{r.result.close();yes(true)}})
    return {decision,closed:resourceClosed,upgraded,locks:[await probe('migration'),await probe('write')],effects}
  })()`)).toEqual({decision:'held',closed:true,upgraded:true,locks:[true,true],effects:{entropy:0,reads:0,writes:0}})
})

test('startup resource presence is single-use and closed resources cannot reacquire',async({page})=>{
  expect(await page.evaluate(`(async()=>{
    await seed();await lifetime.acquire();await lifetime.inspectPresence()
    let repeated=false,legacy=false,acquire=false
    try{await lifetime.inspectPresence()}catch{repeated=true}
    try{lifetime.commitLegacy()}catch{legacy=true}
    await lifetime.close();await lifetime.close()
    try{await lifetime.acquire()}catch{acquire=true}
    return {repeated,legacy,acquire,locks:[await probe('migration'),await probe('write')],effects}
  })()`)).toEqual({repeated:true,legacy:true,acquire:true,locks:[true,true],effects:{entropy:0,reads:0,writes:0}})
})

test('startup resource close cancels an acquisition queued behind migration without releasing the other owner',async({page})=>{
  expect(await page.evaluate(`(async()=>{
    let release,granted
    const entered=new Promise(resolve=>granted=resolve)
    const other=navigator.locks.request(nameOfDatabase+':migration',async()=>{
      granted();await new Promise(resolve=>release=resolve)
    })
    await entered
    const pending=lifetime.acquire().then(()=>'unexpected',()=> 'held')
    await lifetime.close();const result=await pending,held=await probe('migration')
    release();await other
    return {result,held,released:[await probe('migration'),await probe('write')],effects}
  })()`)).toEqual({result:'held',held:false,released:[true,true],effects:{entropy:0,reads:0,writes:0}})
})
