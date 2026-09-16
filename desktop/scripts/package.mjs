import { packager } from '@electron/packager'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { mkdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
const root = fileURLToPath(new URL('../', import.meta.url))
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
  appVersion: version, buildVersion: '5', icon, overwrite: true, asar: true,
  ignore: [/^\/out($|\/)/, /^\/artifacts($|\/)/, /^\/test-results($|\/)/, /^\/test($|\/)/, /^\/scripts($|\/)/, /^\/README.md$/],
  extendInfo: {
    NSMicrophoneUsageDescription: 'KithMoot uses your microphone when you turn it on in a call.',
    NSCameraUsageDescription: 'KithMoot uses your camera when you turn it on in a call.',
    NSLocalNetworkUsageDescription: 'KithMoot connects to devices and relays on your network for calls and messages.',
    NSHighResolutionCapable: true,
  },
})
for (const path of paths) {
  const bundle = resolve(path, 'KithMoot.app')
  // Local Apple Silicon preview only. Public distribution requires Developer ID + notarisation.
  const signed = spawnSync('codesign', ['--force', '--deep', '--sign', '-', bundle], { stdio: 'inherit' })
  if (signed.status) throw new Error('Ad-hoc signing failed')
  const zip = resolve(root, `out/KithMoot-${version}-mac-arm64.zip`)
  if (spawnSync('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', bundle, zip], { stdio: 'inherit' }).status) throw new Error('ZIP failed')
  console.log(`Packaged: ${bundle}\nArchive: ${zip}`)
}
