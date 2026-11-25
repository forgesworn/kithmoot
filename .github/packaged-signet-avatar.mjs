import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect } from '@playwright/test'
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure'
import { encrypt, decrypt, getConversationKey } from 'nostr-tools/nip44'
import { createRumor, createSeal } from 'nostr-tools/nip59'
import { stopIsolatedApp } from './isolated-app.mjs'

const executable = process.argv[2]
assert.ok(executable)
const user = generateSecretKey()
const signer = generateSecretKey()
const pubkey = getPublicKey(user)
const endpoint = getPublicKey(signer)
const label = 'Approved Signet fixture'
const now = () => Math.floor(Date.now() / 1_000)
const profile = await mkdtemp(join(tmpdir(), 'kithmoot-desktop-signet-'))
const subscribers = new Map()
const allowedMethods = new Set()
let app

function deliver(event) {
  for (const [socket, subscriptions] of subscribers) {
    for (const [id, filters] of subscriptions) {
      if (filters.some(filter => (!filter.kinds || filter.kinds.includes(event.kind)) &&
        (!filter['#p'] || event.tags.some(tag => tag[0] === 'p' && filter['#p'].includes(tag[1]))))) {
        socket.send(JSON.stringify(['EVENT', id, event]))
      }
    }
  }
}

try {
  app = await electron.launch({
    executablePath: executable,
    args: [`--user-data-dir=${profile}`, ...(process.env.KITHMOOT_LAB_NO_SANDBOX === '1' ? ['--no-sandbox'] : [])],
    env: { ...process.env, KITHMOOT_DESKTOP_TEST_PROFILE: profile },
    timeout: 40_000,
  })
  const version = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, version: app.getVersion(), profile: app.getPath('userData') }))
  assert.deepEqual(version, { packaged: true, version: '0.1.184', profile })
  const page = await app.firstWindow()
  await page.context().routeWebSocket(/^wss?:/, socket => {
    const subscriptions = new Map()
    subscribers.set(socket, subscriptions)
    socket.onClose(() => subscribers.delete(socket))
    socket.onMessage(raw => {
      const [kind, value, ...rest] = JSON.parse(String(raw))
      if (kind === 'REQ') {
        subscriptions.set(value, rest)
        return socket.send(JSON.stringify(['EOSE', value]))
      }
      if (kind === 'CLOSE') return subscriptions.delete(value)
      if (kind !== 'EVENT' || !verifyEvent(value)) return
      socket.send(JSON.stringify(['OK', value.id, true, '']))
      if (value.kind !== 24133 || !value.tags.some(tag => tag[0] === 'p' && tag[1] === endpoint)) return
      const conversation = getConversationKey(signer, value.pubkey)
      const request = JSON.parse(decrypt(value.content, conversation))
      const result = request.method === 'connect' ? 'ack' : request.method === 'get_public_key' ? pubkey
        : request.method === 'ping' ? 'pong' : request.method === 'sign_event'
        ? JSON.stringify(finalizeEvent(JSON.parse(request.params[0]), user)) : undefined
      if (result !== undefined) allowedMethods.add(request.method)
      const response = { id: request.id, ...(result === undefined ? { error: 'Unsupported fixture method' } : { result }) }
      deliver(finalizeEvent({ kind: 24133, created_at: now(), tags: [['p', value.pubkey]],
        content: encrypt(JSON.stringify(response), conversation) }, signer))
    })
  })
  await page.reload()
  const first = page.locator('#homeSignIn')
  await expect(first).toBeVisible({ timeout: 30_000 })
  await first.click()
  await page.locator('[data-choice="remote-signet"]').click()
  const link = page.locator('#signet-login-open-signet')
  await expect(link).toBeVisible()
  const request = new URL(await link.getAttribute('href'))
  const id = request.searchParams.get('challenge')
  const recipient = request.searchParams.get('sessionPubkey')
  const relay = request.searchParams.get('relay')
  assert.ok(id && recipient && relay)
  await expect.poll(() => [...subscribers.values()].some(subscriptions =>
    [...subscriptions.values()].some(filters => filters.some(filter =>
      filter.kinds?.includes(1059) && filter['#p']?.includes(recipient))))).toBe(true)
  const authEvent = finalizeEvent({ kind: 21236, created_at: now(),
    tags: [['challenge',id],['origin',request.searchParams.get('origin')]], content: '' }, user)
  const response = { type: 'signet-auth-response', requestId: id, authEvent, displayName: label,
    bunkerUri: `bunker://${endpoint}?relay=${encodeURIComponent(relay)}` }
  const rumor = createRumor({ kind: 29999, created_at: now(), tags: [['session',id],['status','approved']],
    content: JSON.stringify(response) }, user)
  const seal = createSeal(rumor, user, recipient)
  const outer = generateSecretKey()
  deliver(finalizeEvent({ kind: 1059, created_at: now(), tags: [['p',recipient]],
    content: encrypt(JSON.stringify(seal), getConversationKey(outer, recipient)) }, outer))

  const avatar = page.locator('#railPersonas')
  await expect(avatar).toHaveAttribute('aria-label', `Account menu for ${label}`, { timeout: 40_000 })
  assert.ok(allowedMethods.has('get_public_key') || allowedMethods.has('connect'))
  await avatar.hover()
  await expect(page.locator('#railPersonaTip')).toBeVisible()
  await expect(page.locator('#railPersonaTip')).toHaveText(label)
  await avatar.click()
  await expect(page.locator('#personaCurrentName')).toHaveText(label)
  console.log(JSON.stringify({ platform: process.platform, architecture: process.arch, version: version.version,
    packaged: true, approvedHandleOnFirstSignIn: true, hoverHandle: true, openedPersonaMenu: true }))
} finally {
  await stopIsolatedApp(app, profile)
  await rm(profile, { recursive: true, force: true })
}
