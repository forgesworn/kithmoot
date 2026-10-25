import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readRuntimeConfig } from './mixed-invitation-runtime-config.mjs'
const status = { ready:true,linkUrl:'wss://link-lab.forgesworn.dev:28442',signerRelay:'wss://link-lab.forgesworn.dev:28444' }
test('read-only ready status derives the exact relay config without pairing fields', () => {
  assert.deepEqual(readRuntimeConfig({...status,pairingUri:'private-unused',bunkerUri:'private-unused',fixture:{private:'unused'}}),
    {linkUrl:status.linkUrl,relayUrl:status.signerRelay,publicRelay:status.signerRelay})
})
test('unready, missing and credential-bearing endpoints refuse', () => {
  for (const changed of [{ready:false},{linkUrl:undefined},{signerRelay:undefined},{linkUrl:'ws://localhost:28442'},
    {signerRelay:'wss://user:secret@localhost:28444'},{signerRelay:'wss://localhost:28444/?token=secret'}]) {
    assert.throws(()=>readRuntimeConfig({...status,...changed}))
  }
})
