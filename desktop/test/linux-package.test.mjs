import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { arMember, packageStanza, releaseFile, compareVersions } from '../scripts/apt-repo.mjs'
import { controlFile, desktopEntry, DEPENDS, DESKTOP_ID } from '../scripts/package-deb.mjs'

const source = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8')

test('the menu entry has the id the app announces for its badge', () => {
  assert.equal(DESKTOP_ID, 'dev.forgesworn.kithmoot.desktop')
  assert.match(source('main.mjs'), /setDesktopName\('dev\.forgesworn\.kithmoot\.desktop'\)/)
  assert.match(desktopEntry(), /^Exec=\/opt\/KithMoot\/kithmoot$/m)
})

test('a renamed t64 library is preferred, so apt never fills it with a stub', () => {
  for (const alternative of DEPENDS.filter(entry => entry.includes('t64'))) assert.match(alternative, /^\S+t64 \| /)
  assert.ok(DEPENDS.includes('libasound2t64 | libasound2'))
})

test('the control file names the Debian architecture', () => {
  const control = controlFile({ version: '0.1.33', arch: 'x64', installedKiB: 10 })
  assert.match(control, /^Package: kithmoot$/m)
  assert.match(control, /^Architecture: amd64$/m)
  assert.match(control, /^Version: 0\.1\.33$/m)
  assert.ok(control.endsWith('\n'))
})

test('the package source, keyring and AppArmor profile are the repository and app the package installs', () => {
  assert.match(source('linux/kithmoot.sources'), /^URIs: https:\/\/github\.com\/forgesworn\/kithmoot\/releases\/download\/apt\/$/m)
  assert.match(source('linux/kithmoot.sources'), /^Signed-By: \/usr\/share\/keyrings\/kithmoot-archive-keyring\.gpg$/m)
  assert.match(source('linux/apparmor-profile'), /profile kithmoot \/opt\/KithMoot\/kithmoot flags=\(unconfined\)/)
  assert.ok(readFileSync(new URL('../linux/kithmoot-archive-keyring.gpg', import.meta.url)).length > 500)
})

test('the postinst removes only the tarball installer\'s own menu entry', () => {
  const script = source('linux/postinst')
  assert.match(script, /grep -qxF "Exec=\\"\$home\/\.local\/share\/kithmoot-desktop\/kithmoot\\""/)
  const commands = script.split('\n').filter(line => !line.trimStart().startsWith('#')).join('\n')
  assert.doesNotMatch(commands, /\.config/)
})

test('a package is read out of its ar archive by member name', () => {
  const member = (name, body) => {
    const header = Buffer.alloc(60, ' ')
    header.write(name, 0, 'latin1'); header.write(String(body.length), 48, 'latin1'); header.write('`\n', 58, 'latin1')
    return Buffer.concat([header, body, body.length % 2 ? Buffer.from('\n') : Buffer.alloc(0)])
  }
  const archive = Buffer.concat([Buffer.from('!<arch>\n'), member('debian-binary', Buffer.from('2.0\n')), member('control.tar.xz/', Buffer.from('abc')), member('data.tar.xz', Buffer.from('data'))])
  assert.deepEqual(arMember(archive, 'control.tar.'), { name: 'control.tar.xz', data: Buffer.from('abc') })
  assert.equal(arMember(archive, 'data.tar.xz').data.toString(), 'data')
  assert.throws(() => arMember(Buffer.from('nope'), 'x'))
})

test('the index points at the package beside it and lists its digests', () => {
  const stanza = packageStanza('Package: kithmoot\nVersion: 1\n', Buffer.from('deb'), 'kithmoot_1_amd64.deb')
  assert.match(stanza, /^Filename: \.\/kithmoot_1_amd64\.deb$/m)
  assert.match(stanza, /^Size: 3$/m)
  assert.match(stanza, /^SHA256: [0-9a-f]{64}$/m)
  const release = releaseFile([['Packages', Buffer.from('x')]], new Date('2026-10-01T09:00:00Z'))
  assert.match(release, /^Date: Thu, 01 Oct 2026 09:00:00 \+0000$/m)
  assert.match(release, /^SHA256:\n [0-9a-f]{64} +1 Packages$/m)
  assert.match(release, /^Origin: KithMoot$/m)
})

test('versions compare numerically', () => {
  assert.ok(compareVersions('0.1.10', '0.1.9') > 0)
  assert.deepEqual(['0.1.33', '0.1.9', '0.1.32'].sort(compareVersions), ['0.1.9', '0.1.32', '0.1.33'])
})
