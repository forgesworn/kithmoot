import { packager } from '@electron/packager'
import { sign } from '@electron/osx-sign'
import { macSigningConfig } from './mac-signing.mjs'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
const root = fileURLToPath(new URL('../', import.meta.url))
const signing = macSigningConfig()
const { version } = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const assets = resolve(root, 'artifacts')
await mkdir(assets, { recursive: true })
const iconset = resolve(assets, 'KithMoot.iconset')
await mkdir(iconset, { recursive: true })
for (const size of [16, 32, 128, 256, 512]) {
  for (const scale of [1, 2]) {
    const out = resolve(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`)
    const result = spawnSync('sips', ['-z', String(size * scale), String(size * scale), resolve(root, '../app/public/pwa-512x512.png'), '--out', out], { stdio: 'ignore' })
    if (result.status) throw new Error('Icon conversion failed')
  }
}
const icon = resolve(assets, 'KithMoot.icns')
if (spawnSync('iconutil', ['-c', 'icns', iconset, '-o', icon]).status) throw new Error('Icon build failed')
const paths = await packager({
  dir: root, out: resolve(root, 'out'), name: 'KithMoot', platform: 'darwin', arch: 'arm64',
  electronVersion: '44.4.1', appBundleId: 'dev.forgesworn.kithmoot.desktop',
  appVersion: version, buildVersion: '13', icon, overwrite: true, asar: true,
  ignore: [/^\/out($|\/)/, /^\/artifacts($|\/)/, /^\/test-results($|\/)/, /^\/test($|\/)/, /^\/scripts($|\/)/, /^\/README.md$/],
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
  if (signing.localPreview) {
    const signed = spawnSync('codesign', ['--force', '--deep', '--sign', '-', bundle], { stdio: 'inherit' })
    if (signed.status) throw new Error('Local signing failed')
  } else {
    await sign({ app: bundle, identity: signing.identity, keychain: signing.keychain,
      platform: 'darwin', type: 'distribution',
      optionsForFile: () => ({ hardenedRuntime: true, entitlements: [
        'com.apple.security.cs.allow-jit', 'com.apple.security.device.audio-input', 'com.apple.security.device.camera',
      ] }),
    })
    if (spawnSync('codesign', ['--verify', '--deep', '--strict', bundle], { stdio: 'inherit' }).status) throw new Error('Signature verification failed')
  }
  const archive = resolve(root, `out/KithMoot-${version}-mac-arm64${signing.localPreview ? '-local-preview' : ''}.zip`)
  const zip = signing.localPreview ? archive : resolve(root, `out/.KithMoot-${version}-pending-notarisation.zip`)
  if (spawnSync('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', bundle, zip], { stdio: 'inherit' }).status) throw new Error('ZIP failed')
  if (!signing.localPreview) {
    const submitted = spawnSync('xcrun', ['notarytool', 'submit', zip, '--keychain-profile', signing.profile, '--wait', '--output-format', 'json'], { encoding: 'utf8' })
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
