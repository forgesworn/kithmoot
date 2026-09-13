#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { accessSync, constants, createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'

function fail(message) {
  console.error(`verify-android-publication: ${message}`)
  process.exit(1)
}

const options = {
  manifest: resolve('site/android-release.json'),
  site: resolve('site/index.html'),
  apk: undefined,
}
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index]
  if (argument === '--manifest' || argument === '--site' || argument === '--apk') {
    const value = process.argv[index + 1]
    if (!value) fail(`${argument} needs a path`)
    options[argument.slice(2)] = resolve(value)
    index += 1
  } else {
    fail(`unknown argument ${argument}`)
  }
}

let publication
try {
  publication = JSON.parse(readFileSync(options.manifest, 'utf8'))
} catch (error) {
  fail(`cannot read ${options.manifest}: ${error.message}`)
}

const sha256 = value => typeof value === 'string' ? value.replaceAll(':', '').toLowerCase() : ''
const requireString = (name, pattern) => {
  const value = publication[name]
  if (typeof value !== 'string' || (pattern && !pattern.test(value))) fail(`${name} is invalid`)
  return value
}
const requireInteger = name => {
  const value = publication[name]
  if (!Number.isSafeInteger(value) || value < 0) fail(`${name} is invalid`)
  return value
}

if (publication.schemaVersion !== 1) fail('schemaVersion must be 1')
const channel = requireString('channel', /^(preview|production)$/)
const applicationId = requireString('applicationId', /^[a-z][a-z0-9_.]+$/)
const versionName = requireString('versionName', /^\d+\.\d+\.\d+$/)
const versionCode = requireInteger('versionCode')
const minSdk = requireInteger('minSdk')
const targetSdk = requireInteger('targetSdk')
const expectedApkSha = sha256(requireString('apkSha256'))
const expectedCertificate = sha256(requireString('currentCertificateSha256'))
const downloadFilename = requireString('downloadFilename', /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.apk$/)
if (!/^[0-9a-f]{64}$/.test(expectedApkSha)) fail('apkSha256 must be a SHA-256 digest')
if (!/^[0-9a-f]{64}$/.test(expectedCertificate)) fail('currentCertificateSha256 must be a SHA-256 digest')
if (downloadFilename !== `kithmoot-${versionName}-${channel}.apk`) fail('downloadFilename does not match the release version and channel')

const schemes = publication.signatureSchemes
if (!schemes || ['v1', 'v2', 'v3'].some(name => typeof schemes[name] !== 'boolean')) {
  fail('signatureSchemes must contain boolean v1, v2 and v3 values')
}
if (channel === 'production') {
  if (versionCode <= 22 || minSdk !== 33 || targetSdk !== 35) fail('production release must be code >22, minSdk 33 and targetSdk 35')
  if (schemes.v1 || schemes.v2 || !schemes.v3) fail('production release must use v3 only')
  const previous = sha256(publication.lineage?.previousCertificateSha256)
  if (!/^[0-9a-f]{64}$/.test(previous) || previous === expectedCertificate) fail('production lineage certificates are invalid')
  const capabilities = publication.lineage?.previousCapabilities
  const expectedCapabilities = { installedData: true, sharedUid: false, permission: true, rollback: false, auth: false }
  if (!capabilities || Object.entries(expectedCapabilities).some(([name, value]) => capabilities[name] !== value)) {
    fail('production previous-signer capabilities do not match the reviewed contract')
  }
} else if (publication.lineage !== null) {
  fail('preview publication must not claim a signing lineage')
}

let html
try {
  html = readFileSync(options.site, 'utf8')
} catch (error) {
  fail(`cannot read ${options.site}: ${error.message}`)
}
const article = html.match(/<article\b[^>]*\bid="android"[^>]*>[\s\S]*?<\/article>/)?.[0]
if (!article) fail('site has no Android publication article')
const openingTag = article.match(/^<article\b[^>]*>/)?.[0] ?? ''
const attribute = name => openingTag.match(new RegExp(`\\b${name}="([^"]+)"`))?.[1]
if (attribute('data-android-channel') !== channel) fail('site Android channel does not match the publication manifest')
if (attribute('data-android-version') !== versionName) fail('site Android version does not match the publication manifest')
if (attribute('data-android-version-code') !== String(versionCode)) fail('site Android version code does not match the publication manifest')
if (!article.includes(`Version ${versionName}`)) fail('site copy does not name the publication version')
const requiredLabel = channel === 'production' ? 'Production release.' : 'Debug-signed preview.'
const requiredDownload = channel === 'production' ? 'Download Android' : 'Download Android preview'
if (!article.includes(`<strong>${requiredLabel}</strong>`)) fail(`site copy must say ${requiredLabel}`)
if (!article.includes(`>${requiredDownload}</a>`)) fail(`site download label must say ${requiredDownload}`)
if (!article.includes('href="apk/kithmoot-latest.apk?download=1"')) fail('site download must use the stable APK URL')

if (!options.apk) {
  console.log(`Verified Android publication metadata: ${channel} ${versionName} (code ${versionCode})`)
  process.exit(0)
}

if (!existsSync(options.apk) || !statSync(options.apk).isFile() || statSync(options.apk).size === 0) fail(`APK is missing or empty: ${options.apk}`)

function toolPath(name) {
  const roots = [
    process.env.ANDROID_BUILD_TOOLS,
    process.env.ANDROID_HOME && join(process.env.ANDROID_HOME, 'build-tools', '35.0.0'),
    process.env.ANDROID_SDK_ROOT && join(process.env.ANDROID_SDK_ROOT, 'build-tools', '35.0.0'),
    join(homedir(), 'Library', 'Android', 'sdk', 'build-tools', '35.0.0'),
  ].filter(Boolean)
  for (const root of roots) {
    const candidate = join(root, name)
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {}
  }
  const found = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' })
  if (found.status === 0 && found.stdout.trim()) return found.stdout.trim()
  fail(`${name} is missing; set ANDROID_BUILD_TOOLS or ANDROID_HOME`)
}

function run(tool, args) {
  const result = spawnSync(tool, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  if (result.status !== 0) fail(`${basename(tool)} failed: ${(result.stderr || result.stdout).trim()}`)
  return result.stdout
}

const digest = createHash('sha256')
for await (const chunk of createReadStream(options.apk)) digest.update(chunk)
const actualApkSha = digest.digest('hex')
if (actualApkSha !== expectedApkSha) fail(`APK SHA-256 is ${actualApkSha}, expected ${expectedApkSha}`)

const aapt = toolPath('aapt')
const apksigner = toolPath('apksigner')
const badging = run(aapt, ['dump', 'badging', options.apk])
const packageLine = badging.match(/^package:.*$/m)?.[0] ?? ''
const actualApplicationId = packageLine.match(/\bname='([^']+)'/)?.[1]
const actualVersionCode = Number(packageLine.match(/\bversionCode='(\d+)'/)?.[1])
const actualVersionName = packageLine.match(/\bversionName='([^']+)'/)?.[1]
const actualMinSdk = Number(badging.match(/^sdkVersion:'(\d+)'$/m)?.[1])
const actualTargetSdk = Number(badging.match(/^targetSdkVersion:'(\d+)'$/m)?.[1])
if (actualApplicationId !== applicationId) fail(`APK application ID is ${actualApplicationId}`)
if (actualVersionName !== versionName || actualVersionCode !== versionCode) fail(`APK version is ${actualVersionName} (${actualVersionCode})`)
if (actualMinSdk !== minSdk || actualTargetSdk !== targetSdk) fail(`APK SDK range is ${actualMinSdk}-${actualTargetSdk}`)
if (channel === 'production' && /^application-debuggable/m.test(badging)) fail('refusing a debuggable production APK')

const verification = run(apksigner, ['verify', '--verbose', '--print-certs', options.apk])
const actualCertificate = sha256(verification.match(/^Signer #1 certificate SHA-256 digest: (.+)$/m)?.[1])
if (actualCertificate !== expectedCertificate) fail(`APK certificate is ${actualCertificate}`)
for (const [scheme, expected] of Object.entries(schemes)) {
  const label = scheme.slice(1)
  const actual = verification.match(new RegExp(`^Verified using v${label} scheme \\([^)]*\\): (true|false)$`, 'm'))?.[1] === 'true'
  if (actual !== expected) fail(`APK ${scheme} signature state is ${actual}, expected ${expected}`)
}
const signerDn = verification.match(/^Signer #1 certificate DN: (.+)$/m)?.[1] ?? ''
if (channel === 'production' && /CN=Android Debug/i.test(signerDn)) fail('refusing an Android debug certificate for production')

if (channel === 'production') {
  const lineageOutput = run(apksigner, ['lineage', '--in', options.apk, '--print-certs', '-v'])
  const blocks = lineageOutput.split(/(?=Signer #\d+ in lineage certificate DN:)/).filter(block => block.startsWith('Signer #'))
  if (blocks.length !== 2) fail(`production APK must contain exactly two lineage signers, found ${blocks.length}`)
  const lineageCertificate = block => sha256(block.match(/certificate SHA-256 digest: (.+)$/m)?.[1])
  if (lineageCertificate(blocks[0]) !== sha256(publication.lineage.previousCertificateSha256)) fail('lineage does not start with the published preview certificate')
  if (lineageCertificate(blocks[1]) !== expectedCertificate) fail('lineage does not end with the production certificate')
  const capabilityLabels = {
    installedData: 'installed data',
    sharedUid: 'shared UID',
    permission: 'permission',
    rollback: 'rollback',
    auth: 'auth',
  }
  for (const [name, label] of Object.entries(capabilityLabels)) {
    const actual = blocks[0].match(new RegExp(`^Has ${label} capability\\s*: (true|false)$`, 'mi'))?.[1] === 'true'
    const expected = publication.lineage.previousCapabilities[name]
    if (actual !== expected) fail(`previous signer ${name} capability is ${actual}, expected ${expected}`)
  }
}

console.log(`Verified Android APK: ${channel} ${versionName} (code ${versionCode})`)
console.log(`Certificate SHA-256: ${actualCertificate}`)
console.log(`APK SHA-256: ${actualApkSha}`)
console.log(`Publish as: ${downloadFilename}`)
