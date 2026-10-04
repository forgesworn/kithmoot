#!/usr/bin/env node
// Signs the update manifests the apps check before they update.
//
//   node scripts/update-signing.mjs generate   make the release and recovery keys, once
//   node scripts/update-signing.mjs sign       sign site/downloads/release.json and
//                                              site/android-release.json with the release key
//   node scripts/update-signing.mjs check      verify both against the keys built into the apps
//
// Keys live in KITHMOOT_UPDATE_KEYS (default ~/.kithmoot-signing/update), as
// passphrase-encrypted PKCS#8 with the passphrase beside each. They are never
// printed and never leave that directory. See docs/updates.md.
import { createPrivateKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MANIFESTS, UPDATE_KEYS, signedMessage, verifyManifest } from '../desktop/update-manifest.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const site = resolve(root, 'site')
const keys = process.env.KITHMOOT_UPDATE_KEYS ?? join(homedir(), '.kithmoot-signing/update')
const fail = message => { console.error(`update-signing: ${message}`); process.exit(1) }

const rawPublic = keyObject => Buffer.from(keyObject.export({ format: 'jwk' }).x, 'base64url').toString('hex')

function generate() {
  mkdirSync(keys, { recursive: true, mode: 0o700 })
  for (const name of ['release', 'recovery']) {
    if (existsSync(join(keys, `${name}.pem`))) fail(`${name}.pem already exists; refusing to replace a key`)
  }
  for (const name of ['release', 'recovery']) {
    const passphrase = randomBytes(32).toString('base64url')
    const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
      privateKeyEncoding: { type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase },
    })
    writeFileSync(join(keys, `${name}.password`), `${passphrase}\n`, { mode: 0o600, flag: 'wx' })
    writeFileSync(join(keys, `${name}.pem`), privateKey, { mode: 0o600, flag: 'wx' })
    writeFileSync(join(keys, `${name}.pub`), `${rawPublic(publicKey)}\n`, { mode: 0o644, flag: 'wx' })
    console.log(`${name}: ${rawPublic(publicKey)}`)
  }
}

function loadKey(name) {
  const pem = join(keys, `${name}.pem`)
  if (!existsSync(pem)) fail(`no ${name} key at ${pem}`)
  const passphrase = readFileSync(join(keys, `${name}.password`), 'utf8').trim()
  return createPrivateKey({ key: readFileSync(pem), passphrase })
}

const files = Object.values(MANIFESTS).map(label => ({ label, path: resolve(site, label) }))

function signAll(name) {
  const key = loadKey(name)
  const pub = rawPublic(key)
  if (!UPDATE_KEYS.includes(pub)) fail(`the ${name} key is not one the apps trust`)
  for (const { label, path } of files) {
    const bytes = readFileSync(path)
    JSON.parse(bytes.toString('utf8'))
    const sig = sign(null, signedMessage(label, bytes), key).toString('base64')
    writeFileSync(`${path}.sig`, `${sig}\n`)
    console.log(`signed ${label}`)
  }
  check()
}

function check() {
  for (const { label, path } of files) {
    if (!existsSync(`${path}.sig`)) fail(`${label}.sig is missing`)
    if (!verifyManifest(label, readFileSync(path), readFileSync(`${path}.sig`))) fail(`${label}.sig does not verify; run: node scripts/update-signing.mjs sign`)
    console.log(`verified ${label}`)
  }
}

const command = process.argv[2]
if (command === 'generate') generate()
else if (command === 'sign') signAll(process.argv[3] === '--recovery' ? 'recovery' : 'release')
else if (command === 'check') check()
else fail('usage: update-signing.mjs generate | sign [--recovery] | check')
