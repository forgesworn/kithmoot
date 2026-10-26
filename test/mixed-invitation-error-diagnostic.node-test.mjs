import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appSourceFrames, redactedMessagePreview, safeErrorDiagnostic } from './mixed-invitation-error-diagnostic.mjs'

const origin = 'http://localhost:28445'
const root = '/work/owned'
const modules = new Set(['main.ts','session.ts'])

test('app frames retain only source function, module and position', () => {
  const cap = 'private-capability-sentinel'
  const error = new Error(`failed ${cap}`)
  error.stack = `Error: failed ${cap}\n    at joinFromDoor (${origin}/j/src/main.ts?cap=${cap}:3944:12)\n    at async startSession (${origin}/j/@fs${root}/src/session.ts?t=123&cap=${cap}:3213:7)\n    at forged (${origin}/j/src/${cap}.ts:5:6)\n    at outsider (https://elsewhere.example/j/src/foreign.ts?cap=${cap}:2:1)\n    at unsafe (http://localhost:28445/j/other.ts?cap=${cap}:3:4)`
  const result = safeErrorDiagnostic(error, origin, root, modules, 'app-pageerror')
  assert.deepEqual(result.sourceStackFrames, [
    { sourceClass:'app', functionName:'joinFromDoor', module:'main.ts', line:3944, column:12 },
    { sourceClass:'library', functionName:'async startSession', module:'session.ts', line:3213, column:7 },
  ])
  assert.equal(result.source, 'app-pageerror')
  assert.equal(JSON.stringify(result).includes(cap), false)
  assert.equal(JSON.stringify(result).includes('elsewhere.example'), false)
})

test('foreign, malformed and message-only stacks cannot become app frames', () => {
  assert.deepEqual(appSourceFrames({ stack:`Error: token\n    at x (https://elsewhere.example/j/src/main.ts:1:2)\n    at http://localhost:28445/j/src/main.ts:0:2` },origin,root,modules),[])
  const controller = safeErrorDiagnostic(new Error('controller sentinel'),'http://localhost:28445',root,modules,'controller-operation')
  assert.equal(controller.source,'controller-operation')
  assert.deepEqual(controller.sourceStackFrames,[])
  assert.equal(controller.operatorMessagePreview,'controller sentinel')
})

test('operator preview masks capability URLs, keys, tokens and prospective scalar terms before retention', () => {
  const cap='cap://invite/private-capability-value'
  const nsec='nsec1'+'q'.repeat(58)
  const hex='ab'.repeat(32)
  const token='private_encoded-token_1234567890abcd/next'
  const scalar='Moss room October 25'
  const message=`Cannot open ${cap}; ${nsec}; ${hex}; ${token}; ${scalar}; https://localhost:28445/j/?cap=brief; file:///Users/darren/private/data`
  const preview=redactedMessagePreview(message,[scalar])
  for(const secret of [cap,nsec,hex,token,scalar,'brief','/Users/darren/private/data'])assert.equal(preview.includes(secret),false)
  assert.ok(preview.startsWith('Cannot open '))
  assert.ok(preview.length<=300)
  assert.equal(redactedMessagePreview('x'.repeat(500)).length<=300,true)
})

test('operator stack classes admit only pinned Bark and known package or dependency basenames', () => {
  const cap='private-capability-sentinel'
  const error={stack:`Error: ${cap}\n    at provider (chrome-extension://fixed-extension/provider.js?token=${cap}:10:2)\n    at foo (${origin}/j/@fs${root}/packages/context/src/index.ts?secret=${cap}:11:3)\n    at login (${origin}/j/node_modules/.vite/deps/signet-login.js?secret=${cap}:12:4)\n    at forged (${origin}/j/node_modules/.vite/deps/${cap}.js:13:5)\n    at outsider (https://elsewhere.example/secret.js?${cap}:2:1)`}
  const options={barkOrigin:'chrome-extension://fixed-extension',barkModules:new Set(['provider.js']),packageModules:new Set(['index.ts']),dependencyModules:new Set(['signet-login.js']),privateTerms:[cap]}
  const frames=appSourceFrames(error,origin,root,modules,options)
  assert.deepEqual(frames.map(frame=>[frame.sourceClass,frame.module]),[['bark-extension','provider.js'],['worktree-package','index.ts'],['dependency','signet-login.js'],['dependency','other']])
  assert.equal(JSON.stringify(frames).includes(cap),false)
  assert.equal(JSON.stringify(frames).includes('chrome-extension://'),false)
  assert.equal(JSON.stringify(frames).includes('elsewhere.example'),false)
})
