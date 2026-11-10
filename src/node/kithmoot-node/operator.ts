import { readNodeTurnPorts } from '@forgesworn/fold-kit/node-room'
import { DatabaseSync } from 'node:sqlite'
import { spawnSync } from 'node:child_process'
import { constants, openSync, closeSync, fstatSync, readFileSync, writeFileSync, renameSync, fsyncSync, lstatSync, existsSync, chmodSync, chownSync, unlinkSync, rmSync, realpathSync } from 'node:fs'
import { join, basename, dirname } from 'node:path'
import { networkInterfaces } from 'node:os'
import { X509Certificate, createPrivateKey, randomBytes, createHash } from 'node:crypto'
import { validateConfiguration, type NodeConfiguration } from './runtime.js'
import { stageRelease, activateRelease, protectedDirectory } from './installation.js'
import { verifyRelease, type NodeRelease } from './release.js'
import { nodeRelayRange } from './relay-ports.js'

const paths = { installation: '/opt/kithmoot-node', releases: '/opt/kithmoot-node/releases', configuration: '/etc/kithmoot-node', state: '/var/lib/kithmoot-node', units: '/etc/systemd/system' }
const units = ['kithmoot-node.service', 'kithmoot-node-front.service']
interface InstalledNode { v: 1; phase: 'prepared' | 'ready' | 'updating'; pending?: { directory: string; release: NodeRelease }; acme?: string; firewall?: string[]; release: NodeRelease; directory: string; configuration: NodeConfiguration }
const marker = () => join(paths.configuration, 'installation.json')
function run(command: string, args: string[], allowFailure = false): string {
  const child = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 120000, maxBuffer: 65536 })
  if (child.error || child.status !== 0 && !allowFailure) throw Error(`Node setup command failed: ${command}`)
  return child.stdout ?? ''
}
function requireOperator(): void {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) throw Error('System installation commands require root on Linux')
  const release = readFileSync('/etc/os-release', 'utf8')
  const field = (name: string) => release.match(new RegExp(`^${name}="?([^"\\n]+)`, 'm'))?.[1]
  if (!(field('ID') === 'debian' && Number(field('VERSION_ID')) >= 12 || field('ID') === 'ubuntu' && Number(field('VERSION_ID')) >= 24.04)) throw Error('This installer supports Debian 12+ and Ubuntu 24.04+')
}
/** OS-released lock also serialises ACME and uninstall; a killed installer
 * cannot leave a stale PID lock requiring deletion. */
export function operationLock(path = '/run/lock/kithmoot-node.sqlite'): () => void {
  const fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600)
  try { const info = fstatSync(fd); if (!info.isFile() || info.uid !== process.getuid?.() || info.mode & 0o077) throw Error('Unsafe installer lock') }
  finally { closeSync(fd) }
  const db = new DatabaseSync(path)
  try { db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE') }
  catch { db.close(); throw Error('Another node installation command is running') }
  return () => db.close()
}
function unchangedUnits(installed: InstalledNode): void {
  for (const name of units) {
    const actual = protectedRead(join(paths.units, name))
    if (!actual.equals(protectedRead(join(installed.directory, 'deploy', name)))
      && (!installed.pending || !actual.equals(protectedRead(join(installed.pending.directory, 'deploy', name))))) throw Error('Modified service units need operator review before update or removal')
  }
}
function protectedRead(path: string, limit = 262144): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try { const file = fstatSync(fd); if (!file.isFile() || file.mode & 0o022 || file.size > limit) throw Error('Unsafe node setup input'); return readFileSync(fd) }
  finally { closeSync(fd) }
}
function atomicFile(path: string, value: string | Buffer, mode: number, group?: number): void {
  const temporary = path + `.new-${randomBytes(8).toString('hex')}`
  const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, mode)
  try { writeFileSync(fd, value); fsyncSync(fd) } finally { closeSync(fd) }
  try { chmodSync(temporary, mode); if (group !== undefined) chownSync(temporary, 0, group); renameSync(temporary, path) }
  catch (error) { rmSync(temporary, { force: true }); throw error }
  const parent = openSync(dirname(path), constants.O_RDONLY); try { fsyncSync(parent) } finally { closeSync(parent) }
}
function readInstalled(): InstalledNode {
  const info = lstatSync(marker())
  if (info.uid !== 0) throw Error('Node installation marker is not owned by root')
  const value = JSON.parse(protectedRead(marker()).toString()) as InstalledNode
  if (!value || value.v !== 1 || !['prepared', 'ready', 'updating'].includes(value.phase) || !value.directory?.startsWith(paths.releases + '/') || basename(value.directory).startsWith('.')) throw Error('Invalid managed node installation')
  validateConfiguration(value.configuration); return value
}
function saveInstalled(value: InstalledNode): void { atomicFile(marker(), JSON.stringify(value, null, 2) + '\n', 0o644) }
function account(name: string, home: string): { uid: number; gid: number } {
  const found = run('getent', ['passwd', name], true).trim()
  if (!found) {
    const group = run('getent', ['group', name], true).trim().split(':')
    if (!group[0]) run('groupadd', ['--system', name])
    else if (Number(group[2]) >= 1000 || group[3]) throw Error('Existing service group has unrelated members')
    run('useradd', ['--system', '--no-create-home', '--home-dir', home, '--shell', '/usr/sbin/nologin', '--gid', name, name])
  }
  const row = run('getent', ['passwd', name]).trim().split(':')
  if (row[0] !== name || !/^\d+$/.test(row[2]!) || Number(row[2]) < 1 || Number(row[2]) >= 1000 || row[5] !== home || row[6] !== '/usr/sbin/nologin') throw Error('Existing service account does not belong to this installation')
  return { uid: Number(row[2]), gid: Number(row[3]) }
}
function tlsGroup(): number {
  if (!run('getent', ['group', 'kithmoot-node-tls'], true).trim()) run('groupadd', ['--system', 'kithmoot-node-tls'])
  const row = run('getent', ['group', 'kithmoot-node-tls']).trim().split(':')
  if (!/^\d+$/.test(row[2]!) || (row[3] ?? '').split(',').filter(Boolean).some(name => !['kithmoot-node', 'kithmoot-node-front'].includes(name))) throw Error('TLS group has unrelated members')
  return Number(row[2])
}
function certificates(configuration: NodeConfiguration, certificate: string, key: string, group: number): void {
  if (configuration.tlsGate || !configuration.certificate || !configuration.certificateKey) throw Error('Standalone installation requires its own TLS files')
  const keyPath = realpathSync(key)
  if (lstatSync(keyPath).mode & 0o007) throw Error('TLS private key must not be accessible to other users')
  const cert = protectedRead(realpathSync(certificate)), secret = protectedRead(keyPath)
  try {
    const leaf = new X509Certificate(cert)
    if (!leaf.checkHost(configuration.host) || !leaf.checkHost(`turn.${configuration.host}`) || !leaf.checkPrivateKey(createPrivateKey(secret))
      || Date.parse(leaf.validFrom) > Date.now() || Date.parse(leaf.validTo) <= Date.now()) throw Error('Certificate must be current and cover both node hostnames')
    const directory = join(paths.configuration, 'tls'); protectedDirectory(directory, 0o750); chownSync(directory, 0, group)
    atomicFile(configuration.certificate, cert, 0o644, group); atomicFile(configuration.certificateKey, secret, 0o640, group)
  } finally { secret.fill(0) }
}
function service(name: string, command: string, args: string[]): string { return run('runuser', ['--user', name, '--', command, ...args]) }
function managedUnits(release: string): void {
  for (const name of units) {
    const destination = join(paths.units, name)
    if (existsSync(destination) && !existsSync(marker())) throw Error('A service unit with this name already exists')
    atomicFile(destination, protectedRead(join(release, 'deploy', name)), 0o644)
  }
}
async function ready(command: string): Promise<void> {
  const deadline = Date.now() + 20000
  for (;;) {
    try { const reply = JSON.parse(service('kithmoot-node', command, ['status', '--state', paths.state])); if (reply.ok && reply.result?.ready) return } catch {}
    if (Date.now() >= deadline) throw Error('Node services did not become locally ready; run doctor before pairing')
    await new Promise(resolve => setTimeout(resolve, 500))
  }
}
export function assertNewSystemInstall(): void {
  requireOperator()
  if (existsSync(marker()) || existsSync(join(paths.state, 'node.json'))) throw Error('A node or partial installation already exists; preserve it and use resume, update or doctor')
  for (const name of units) if (existsSync(join(paths.units, name))) throw Error('Existing system service files must be preserved')
}
export async function installSystemNode(bundle: string, input: unknown, certificate: string, key: string, management: { acme?: string; firewall?: 'ufw' } = {}): Promise<void> {
  assertNewSystemInstall()
  if (management.acme && management.acme !== acmeName((input as NodeConfiguration).host)) throw Error('Managed certificate does not match this node')
  const checked = verifyRelease(bundle)
  if (checked.release.platform !== `linux-${process.arch}`) throw Error('Release architecture does not match this server')
  const configuration = validateConfiguration({ ...(input as object), spryBinary: join(paths.installation, 'current/bin/spry-node'), shelterBinary: join(paths.installation, 'current/bin/bothyd'),
    certificate: join(paths.configuration, 'tls/fullchain.pem'), certificateKey: join(paths.configuration, 'tls/privkey.pem') })
  if (configuration.tlsGate) throw Error('Host-managed TLS requires the declarative Archy package')
  if (!Object.values(networkInterfaces()).flat().some(address => address?.family === 'IPv4' && address.address === configuration.relayIp)) throw Error('Relay IP is not assigned to this server')
  // Validate the entire TLS pair before creating accounts or copying state.
  const keyPath = realpathSync(key), inputKey = protectedRead(keyPath)
  try {
    if (lstatSync(keyPath).mode & 0o007) throw Error('TLS private key must not be accessible to other users')
    const leaf = new X509Certificate(protectedRead(realpathSync(certificate)))
    if (!leaf.checkHost(configuration.host) || !leaf.checkHost(`turn.${configuration.host}`) || !leaf.checkPrivateKey(createPrivateKey(inputKey))
      || Date.parse(leaf.validFrom) > Date.now() || Date.parse(leaf.validTo) <= Date.now()) throw Error('Invalid TLS pair for these node hostnames')
  } finally { inputKey.fill(0) }
  for (const name of units) if (existsSync(join(paths.units, name))) throw Error('Existing system service files must be preserved')
  protectedDirectory(paths.configuration); protectedDirectory(paths.installation)
  const staged = stageRelease(bundle, paths.releases)
  const node = account('kithmoot-node', paths.state); account('kithmoot-node-front', '/nonexistent')
  const group = tlsGroup()
  for (const name of ['kithmoot-node', 'kithmoot-node-front']) run('usermod', ['--append', '--groups', 'kithmoot-node-tls', name])
  certificates(configuration, certificate, key, group)
  protectedDirectory(paths.state, 0o700); chownSync(paths.state, node.uid, node.gid); chmodSync(paths.state, 0o700)
  const installed: InstalledNode = { v: 1, phase: 'prepared', directory: staged.directory, release: staged.release, configuration, ...(management.acme ? { acme: management.acme } : {}), ...(management.firewall ? { firewall: [] } : {}) }; saveInstalled(installed)
  atomicFile(join(paths.configuration, 'front.json'), JSON.stringify({ v: 1, host: configuration.host, relayIp: configuration.relayIp, deskPort: configuration.deskPort,
    spryPort: configuration.spryPort, shelterPort: configuration.shelterPort, ...(configuration.turnPorts ? { turnPorts: configuration.turnPorts } : {}), ...(configuration.relayPortFirst ? { relayPortFirst: configuration.relayPortFirst } : {}), ...(configuration.relayPortCount ? { relayPortCount: configuration.relayPortCount } : {}), certificate: configuration.certificate, certificateKey: configuration.certificateKey }) + '\n', 0o644)
  const initial = join(paths.configuration, 'initial.json'); atomicFile(initial, JSON.stringify(configuration), 0o640, node.gid)
  const command = join(staged.directory, 'kithmoot-node')
  service('kithmoot-node', command, ['init', '--state', paths.state, '--configuration', initial]); unlinkSync(initial)
  activateRelease(paths.installation, staged.directory); managedUnits(staged.directory)
  run('systemctl', ['daemon-reload']); run('systemctl', ['reset-failed', ...units], true); run('systemctl', ['enable', '--now', ...units]); await ready(command)
  const report = JSON.parse(service('kithmoot-node', command, ['doctor', '--state', paths.state]))
  if (!report.localReady) throw Error('Local doctor failed; preserve the installation and inspect doctor before pairing')
  installed.phase = 'ready'; saveInstalled(installed)
}
export async function resumeSystemNode(): Promise<void> {
  requireOperator(); const installed = readInstalled()
  if (installed.phase === 'updating') { await rollbackUpdate(installed); return }
  verifyRelease(installed.directory, installed.release)
  for (const name of units) if (existsSync(join(paths.units, name)) && !protectedRead(join(paths.units, name)).equals(protectedRead(join(installed.directory, 'deploy', name)))) throw Error('Modified service units need operator review before recovery')
  const c = installed.configuration
  atomicFile(join(paths.configuration, 'front.json'), JSON.stringify({ v: 1, host: c.host, relayIp: c.relayIp, deskPort: c.deskPort, spryPort: c.spryPort, shelterPort: c.shelterPort, ...(c.turnPorts ? { turnPorts: c.turnPorts } : {}), ...(c.relayPortFirst ? { relayPortFirst: c.relayPortFirst } : {}), ...(c.relayPortCount ? { relayPortCount: c.relayPortCount } : {}), certificate: c.certificate, certificateKey: c.certificateKey }) + '\n', 0o644)
  const command = join(installed.directory, 'kithmoot-node')
  if (existsSync(join(paths.state, 'initialising')) || !existsSync(join(paths.state, 'node.json'))) {
    const node = account('kithmoot-node', paths.state), initial = join(paths.configuration, 'initial.json')
    atomicFile(initial, JSON.stringify(installed.configuration), 0o640, node.gid)
    service('kithmoot-node', command, [existsSync(join(paths.state, 'initialising')) ? 'resume-init' : 'init', '--state', paths.state, '--configuration', initial])
  }
  if (existsSync(join(paths.configuration, 'initial.json'))) unlinkSync(join(paths.configuration, 'initial.json'))
  activateRelease(paths.installation, installed.directory); managedUnits(installed.directory)
  run('systemctl', ['daemon-reload']); run('systemctl', ['reset-failed', ...units], true); run('systemctl', ['enable', '--now', ...units]); await ready(command)
  const report = JSON.parse(service('kithmoot-node', command, ['doctor', '--state', paths.state]))
  if (!report.localReady) throw Error('Recovered node failed local doctor checks')
  if (installed.acme) manageAcme(installed.acme)
  if (installed.firewall !== undefined) manageFirewall()
  saveInstalled({ ...readInstalled(), phase: 'ready' })
}
async function rollbackUpdate(installed: InstalledNode): Promise<void> {
  verifyRelease(installed.directory, installed.release)
  if (installed.pending) verifyRelease(installed.pending.directory, installed.pending.release)
  unchangedUnits(installed)
  run('systemctl', ['stop', ...units.slice().reverse()], true)
  activateRelease(paths.installation, installed.directory, installed.release); managedUnits(installed.directory)
  run('systemctl', ['daemon-reload']); run('systemctl', ['reset-failed', ...units], true); run('systemctl', ['start', ...units])
  await ready(join(installed.directory, 'kithmoot-node'))
  const report = JSON.parse(service('kithmoot-node', join(installed.directory, 'kithmoot-node'), ['doctor', '--state', paths.state]))
  if (!report.localReady) throw Error('Rollback failed local doctor checks; recovery remains pending')
  const { pending: _pending, ...previous } = installed
  saveInstalled({ ...previous, phase: 'ready' })
}
export async function updateSystemNode(bundle: string): Promise<void> {
  requireOperator(); let installed = readInstalled()
  if (installed.phase === 'prepared') throw Error('Resume the interrupted installation before updating')
  if (installed.phase === 'updating') { await rollbackUpdate(installed); installed = readInstalled() }
  const staged = stageRelease(bundle, paths.releases)
  if (staged.release.platform !== `linux-${process.arch}`) throw Error('Release architecture does not match this server')
  verifyRelease(installed.directory, installed.release)
  unchangedUnits(installed)
  const updating: InstalledNode = { ...installed, phase: 'updating', pending: { directory: staged.directory, release: staged.release } }
  saveInstalled(updating)
  run('systemctl', ['stop', ...units.slice().reverse()])
  try {
    activateRelease(paths.installation, staged.directory); managedUnits(staged.directory)
    run('systemctl', ['daemon-reload']); run('systemctl', ['reset-failed', ...units], true); run('systemctl', ['start', ...units]); await ready(join(staged.directory, 'kithmoot-node'))
    const report = JSON.parse(service('kithmoot-node', join(staged.directory, 'kithmoot-node'), ['doctor', '--state', paths.state]))
    if (!report.localReady) throw Error('Updated node failed local doctor checks')
    saveInstalled({ ...installed, phase: 'ready', directory: staged.directory, release: staged.release })
  } catch (error) {
    await rollbackUpdate(updating); throw error
  }
}
export function uninstallSystemNode(deleteEverything: boolean): void {
  requireOperator(); if (!deleteEverything) throw Error('Uninstall requires --delete-everything')
  const installed = readInstalled(), command = join(installed.directory, 'kithmoot-node')
  if (installed.phase !== 'ready') throw Error('Recover the interrupted installation before removing it')
  verifyRelease(installed.directory, installed.release); unchangedUnits(installed)
  account('kithmoot-node', paths.state); account('kithmoot-node-front', '/nonexistent'); tlsGroup()
  let prepared: { ok?: boolean; result?: { deleteReady?: boolean } }
  try { prepared = JSON.parse(service('kithmoot-node', command, ['prepare-delete', '--state', paths.state])) }
  catch { throw Error('Start the node, close hosted rooms in KithMoot and check their completion before deleting the node') }
  if (!prepared.ok || prepared.result?.deleteReady !== true) throw Error('Close hosted rooms in KithMoot before deleting the node')
  removeFirewall(installed)
  if (installed.acme) {
    if (installed.acme !== acmeName(installed.configuration.host)) throw Error('Invalid managed certificate metadata')
    if (!protectedRead(acmeHookPath).equals(Buffer.from(acmeHook(installed.acme)))) throw Error('Modified certificate renewal hook needs operator review')
    run('certbot', ['delete', '--non-interactive', '--cert-name', installed.acme]); unlinkSync(acmeHookPath)
  }
  run('systemctl', ['disable', '--now', ...units.slice().reverse()])
  for (const name of units) unlinkSync(join(paths.units, name))
  run('systemctl', ['daemon-reload'])
  rmSync(paths.state, { recursive: true }); rmSync(paths.configuration, { recursive: true }); rmSync(paths.installation, { recursive: true })
  for (const name of ['kithmoot-node-front', 'kithmoot-node']) { run('userdel', [name]); run('groupdel', [name], true) }
  run('groupdel', ['kithmoot-node-tls'])
}
export function refreshSystemCertificates(certificate: string, key: string): void {
  requireOperator(); const installed = readInstalled()
  certificates(installed.configuration, certificate, key, tlsGroup())
  run('systemctl', ['reload', 'kithmoot-node-front.service']); run('systemctl', ['restart', 'kithmoot-node.service'])
}

export function acmeName(host: string): string { return 'kithmoot-node-' + createHash('sha256').update(host).digest('hex').slice(0, 16) }
const acmeHookPath = '/etc/letsencrypt/renewal-hooks/deploy/kithmoot-node.sh'
export function acmeHook(name: string): string {
  if (!/^kithmoot-node-[a-f0-9]{16}$/.test(name)) throw Error('Invalid managed certificate name')
  return '#!/bin/sh\nset -eu\ncase "${RENEWED_LINEAGE:-}" in\n  /etc/letsencrypt/live/' + name + ')\n    exec /opt/kithmoot-node/current/kithmoot-node certificates --certificate "$RENEWED_LINEAGE/fullchain.pem" --certificate-key "$RENEWED_LINEAGE/privkey.pem"\n    ;;\nesac\n'
}
export function manageAcme(name: string): void {
  requireOperator(); const installed = readInstalled()
  if (name !== acmeName(installed.configuration.host)) throw Error('Managed certificate does not match this node')
  const hook = acmeHook(name)
  protectedDirectory(dirname(acmeHookPath))
  if (existsSync(acmeHookPath) && protectedRead(acmeHookPath).toString() !== hook) throw Error('Existing certificate renewal hook must be preserved')
  saveInstalled({ ...installed, acme: name })
  atomicFile(acmeHookPath, hook, 0o755)
  run('systemctl', ['enable', '--now', 'certbot.timer'])
}

export function nodeFirewallRules(configuration: NodeConfiguration): string[] {
  const ports = readNodeTurnPorts(configuration.turnPorts)!, range = nodeRelayRange(configuration)
  return ['443/tcp', `${ports.udpTcp}/tcp`, `${ports.udpTcp}/udp`, `${ports.tls}/tcp`, `${range.first}:${range.last}/udp`]
}
const firewallComment = 'KithMoot-node-managed'
export function checkManagedFirewall(): void {
  requireOperator()
  if (!/^Status: active$/m.test(run('ufw', ['status']))) throw Error('Managed firewall setup requires an already active UFW firewall; it never enables UFW or changes SSH rules')
}
function firewallLine(rule: string): string { return `ufw allow ${rule} comment '${firewallComment}'` }
function firewallAdded(): string[] { return run('ufw', ['show', 'added']).split('\n').map(line => line.trim().replace(/"/g, "'")) }
export function manageFirewall(): void {
  checkManagedFirewall(); let installed = readInstalled()
  for (const rule of nodeFirewallRules(installed.configuration)) {
    const lines = firewallAdded()
    // Preserve existing rules, including identical rules owned by the operator.
    if (lines.some(line => line === `ufw allow ${rule}` || line.startsWith(`ufw allow ${rule} comment `))) continue
    installed = { ...installed, firewall: [...new Set([...(installed.firewall ?? []), rule])] }
    saveInstalled(installed) // Journal before adding: recovery can identify our tagged rule.
    // Plain `allow` can replace the comment on an equivalent existing rule.
    // Insertion preserves that rule and its owner's comment instead.
    run('ufw', ['insert', '1', 'allow', rule, 'comment', firewallComment])
    if (!firewallAdded().includes(firewallLine(rule))) {
      // UFW may recognise an equivalent rule whose spelling we did not.
      // Its ownership stays with the operator, including during removal.
      installed = { ...installed, firewall: installed.firewall!.filter(value => value !== rule) }
      saveInstalled(installed)
    }
  }
}
function removeFirewall(installed: InstalledNode): void {
  if (!installed.firewall?.length) return
  checkManagedFirewall()
  for (const rule of installed.firewall) {
    if (!nodeFirewallRules(installed.configuration).includes(rule)) throw Error('Invalid managed firewall metadata')
    const lines = firewallAdded()
    if (lines.includes(firewallLine(rule))) run('ufw', ['--force', 'delete', 'allow', rule, 'comment', firewallComment])
    else if (lines.some(line => line.startsWith(`ufw allow ${rule} comment `))) throw Error('Modified node firewall rules need operator review')
  }
}
