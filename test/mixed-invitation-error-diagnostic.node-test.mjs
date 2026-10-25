import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appSourceFrames, safeErrorDiagnostic } from './mixed-invitation-error-diagnostic.mjs'

const origin = 'http://localhost:28445'
const root = '/work/owned'
const modules = new Set(['main.ts','session.ts'])

test('app frames retain only source function, module and position', () => {
  const cap = 'private-capability-sentinel'
  const error = new Error(`failed ${cap}`)
  error.stack = `Error: failed ${cap}\n    at joinFromDoor (${origin}/j/src/main.ts?cap=${cap}:3944:12)\n    at async startSession (${origin}/j/@fs${root}/src/session.ts?t=123&cap=${cap}:3213:7)\n    at forged (${origin}/j/src/${cap}.ts:5:6)\n    at outsider (https://elsewhere.example/j/src/foreign.ts?cap=${cap}:2:1)\n    at unsafe (http://localhost:28445/j/other.ts?cap=${cap}:3:4)`
  const result = safeErrorDiagnostic(error, origin, root, modules, 'app-pageerror')
  assert.deepEqual(result.sourceStackFrames, [
    { functionName:'joinFromDoor', module:'main.ts', line:3944, column:12 },
    { functionName:'async startSession', module:'session.ts', line:3213, column:7 },
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
  assert.equal(JSON.stringify(controller).includes('controller sentinel'),false)
})
