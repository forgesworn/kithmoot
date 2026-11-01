import { packager } from '@electron/packager'
import { sign } from '@electron/osx-sign'
import { macSigningConfig, notarySubmissionArgs, notaryCommand } from './mac-signing.mjs'
import { hashFile, stageHelper, writeManifest } from './spry-helper.mjs'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
const root = fileURLToPath(new URL('../', import.meta.url))
const signing = macSigningConfig()
const { version } = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const assets = resolve(root, 'artifacts')
await mkdir(assets, { recursive: true })
const iconset = resolve(assets, 'KithMoot.iconset')
await mkdir(iconset, { recursive: true })
// Pre-rendered by `npm run brand:build` at the repository root.
for (const size of [16, 32, 128, 256, 512]) {
  for (const scale of [1, 2]) {
    await copyFile(resolve(root, `icons/kithmoot-${size * scale}.png`), resolve(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`))
  }
}
const icon = resolve(assets, 'KithMoot.icns')
if (spawnSync('iconutil', ['-c', 'icns', iconset, '-o', icon]).status) throw new Error('Icon build failed')
// The built-in call relay's helper, outside the asar at
// Contents/Resources/spry/spry-node. It is signed here, before the app, and
// the app's signing below leaves it alone: signing rewrites a binary, so the
// manifest the app checks must hold the hash of these final bytes.
const helper = await stageHelper('darwin-arm64')
const helperSigning = signing.localPreview
  ? ['--force', '--sign', '-', helper.file]
  : ['--force', '--options', 'runtime', '--timestamp', '--sign', signing.identity,
    ...(signing.keychain ? ['--keychain', signing.keychain] : []), helper.file]
if (spawnSync('codesign', helperSigning, { stdio: 'inherit' }).status) throw new Error('Signing the built-in relay helper failed')
const helperHash = await hashFile(helper.file)
await writeManifest({ 'darwin-arm64': helperHash }, { version: helper.version })
const isHelper = file => file.endsWith('/Contents/Resources/spry/spry-node')
const paths = await packager({
  dir: root, out: resolve(root, 'out'), name: 'KithMoot', platform: 'darwin', arch: 'arm64',
  electronVersion: '44.9.3', appBundleId: 'dev.forgesworn.kithmoot.desktop',
  appVersion: version, buildVersion: '123', icon, overwrite: true, asar: true, extraResource: [helper.dir],
  protocols: [{ name: 'KithMoot invitation', schemes: ['kithmoot'] }],
  ignore: [/^\/out($|\/)/, /^\/artifacts($|\/)/, /^\/icons($|\/)/, /^\/test-results($|\/)/, /^\/test($|\/)/, /^\/scripts($|\/)/, /^\/README.md$/],
  extendInfo: {
    NSAudioCaptureUsageDescription: 'KithMoot shares system sound when you choose to include audio with your screen share.',
    NSMicrophoneUsageDescription: 'KithMoot uses your microphone when you turn it on in a call.',
    NSCameraUsageDescription: 'KithMoot uses your camera when you turn it on in a call.',
    NSLocalNetworkUsageDescription: 'KithMoot connects to devices and relays on your network for calls and messages.',
    NSHighResolutionCapable: true,
  },
})
for (const path of paths) {
  const bundle = resolve(path, 'KithMoot.app')
  const bundledHelper = resolve(bundle, 'Contents/Resources/spry/spry-node')
  if (signing.localPreview) {
    await sign({ app: bundle, identity: '-', identityValidation: false, platform: 'darwin', ignore: isHelper,
      optionsForFile: () => ({ hardenedRuntime: true }) })
  } else {
    await sign({ app: bundle, identity: signing.identity, keychain: signing.keychain,
      platform: 'darwin', type: 'distribution', ignore: isHelper,
      optionsForFile: () => ({ hardenedRuntime: true, entitlements: [
        'com.apple.security.cs.allow-jit', 'com.apple.security.device.audio-input', 'com.apple.security.device.camera',
      ] }),
    })
  }
  if (spawnSync('codesign', ['--verify', '--deep', '--strict', bundle], { stdio: 'inherit' }).status) throw new Error('Signature verification failed')
  if (spawnSync('codesign', ['--verify', '--strict', bundledHelper], { stdio: 'inherit' }).status) throw new Error('The built-in relay helper is not validly signed')
  if (await hashFile(bundledHelper) !== helperHash) throw new Error('The bundled relay helper changed after its hash was recorded')
  if (!signing.localPreview) {
    const shown = spawnSync('codesign', ['-dv', '--verbose=2', bundledHelper], { encoding: 'utf8' })
    if (!shown.stderr.includes(`Authority=${signing.identity}`) || !shown.stderr.includes('flags=0x10000(runtime)')) {
      throw new Error('The built-in relay helper is not signed with the app\'s Developer ID and hardened runtime')
    }
  }
  const archive = resolve(root, `out/KithMoot-${version}-mac-arm64${signing.localPreview ? '-local-preview' : ''}.zip`)
  const zip = signing.localPreview ? archive : resolve(root, `out/.KithMoot-${version}-pending-notarisation.zip`)
  if (spawnSync('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', bundle, zip], { stdio: 'inherit' }).status) throw new Error('ZIP failed')
  if (!signing.localPreview) {
    const notary = notaryCommand(notarySubmissionArgs(zip, signing), signing)
    const submitted = spawnSync(notary.command, notary.args, { encoding: 'utf8' })
    await writeFile(resolve(assets, `notarisation-${version}.json`), submitted.stdout || JSON.stringify({ error: submitted.stderr, status: submitted.status }))
    if (submitted.status || JSON.parse(submitted.stdout).status !== 'Accepted') throw new Error('Apple did not accept notarisation. The archive must not be published.')
    for (const args of [['stapler', 'staple', bundle], ['stapler', 'validate', bundle]]) {
      if (spawnSync('xcrun', args, { stdio: 'inherit' }).status) throw new Error('Notarisation ticket verification failed')
    }
    if (spawnSync('spctl', ['--assess', '--type', 'execute', '--verbose=2', bundle], { stdio: 'inherit' }).status) throw new Error('Gatekeeper refused the signed app')
    if (spawnSync('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', bundle, archive], { stdio: 'inherit' }).status) throw new Error('Stapled ZIP failed')
    await rm(zip)
  }
  console.log(`Packaged: ${bundle}\nArchive: ${archive}`)
}
