import { packager } from '@electron/packager'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { basename, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = fileURLToPath(new URL('../', import.meta.url))
const { version } = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const [directory] = await packager({
  dir: root,
  out: resolve(root, 'out'),
  name: 'KithMoot',
  executableName: 'KithMoot',
  platform: 'win32',
  arch: 'x64',
  electronVersion: '44.4.1',
  appVersion: version,
  overwrite: true,
  asar: true,
  icon: resolve(root, 'artifacts/KithMoot.ico'),
  ignore: [/^\/out($|\/)/, /^\/artifacts($|\/)/, /^\/test-results($|\/)/, /^\/test($|\/)/, /^\/scripts($|\/)/, /^\/README.md$/],
})

await writeFile(resolve(directory, 'README.txt'), `KithMoot ${version} - Windows x64 portable preview

Extract the whole ZIP, then open KithMoot.exe. Keep the folder together.
Requires a current 64-bit Windows 10 or Windows 11 system.
Camera, microphone and screen capture use Windows and Chromium permission controls.
Share an area is available; screen audio uses Windows loopback capture where supported.
The Chromium sandbox remains enabled.
Your encrypted local profile lives separately under the current Windows account and survives replacing this folder.
Updates are manual. Close KithMoot before replacing the extracted application folder.
To remove the application, close it and delete the extracted folder. Remove its profile separately only if you also want to erase this device's local KithMoot state.
This preview is not Authenticode signed. Windows may identify its publisher as unknown or block it under local security policy.
`)

const executable = await readFile(resolve(directory, 'KithMoot.exe'))
if (executable[0] !== 0x4d || executable[1] !== 0x5a) throw new Error('Windows executable has no MZ header')
const peOffset = executable.readUInt32LE(0x3c)
if (executable.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') throw new Error('Windows executable has no PE header')
if (executable.readUInt16LE(peOffset + 4) !== 0x8664) throw new Error('Windows executable is not x64')
await readFile(resolve(directory, 'resources/app.asar'))

const archiveName = `KithMoot-${version}-windows-x64.zip`
const archive = resolve(root, 'out', archiveName)
const zipped = spawnSync('zip', ['-X', '-q', '-r', archive, basename(directory)], {
  cwd: resolve(directory, '..'),
  stdio: 'inherit',
})
if (zipped.status !== 0) throw new Error('Windows archive failed')
const hash = createHash('sha256').update(await readFile(archive)).digest('hex')
await writeFile(`${archive}.sha256`, `${hash}  ${archiveName}\n`)
console.log(`${hash}  ${archive}`)
console.log('Unsigned Windows preview: Authenticode publisher verification is not available.')
