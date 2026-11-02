import { spawnSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { resolve, join } from 'node:path'
import { installSystemNode, updateSystemNode, uninstallSystemNode, refreshSystemCertificates, resumeSystemNode, operationLock, assertNewSystemInstall, acmeName, manageAcme, checkManagedFirewall, manageFirewall } from './operator.js'
import { validateConfiguration } from './runtime.js'
import { verifyRelease } from './release.js'

const valueFlags = ['--configuration', '--name', '--hosting', '--relay-ip', '--public-ip', '--bandwidth', '--storage-bytes', '--min-free-bytes', '--max-rooms', '--origins', '--certificate', '--certificate-key', '--firewall']
const booleanFlags = ['--acme', '--accept-acme-terms', '--delete-everything']
function parse(args: string[]): Map<string, string | true> {
  const values = new Map<string, string | true>()
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]!
    if (values.has(flag)) throw Error('Repeated setup option')
    if (booleanFlags.includes(flag)) values.set(flag, true)
    else if (valueFlags.includes(flag) && args[index + 1] && !args[index + 1]!.startsWith('--')) values.set(flag, args[++index]!)
    else throw Error('Unknown or incomplete setup option')
  }
  return values
}
export function systemReadOnly(command: 'pair' | 'status' | 'doctor'): number {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) throw Error('Use sudo for the installed node operator command')
  const executable = '/opt/kithmoot-node/current/kithmoot-node'
  if (!existsSync(executable)) throw Error('No managed KithMoot node is installed')
  // Inherit the terminal for pairing; never capture or log its one-use code.
  const child = spawnSync('runuser', ['--user', 'kithmoot-node', '--', executable, command, '--state', '/var/lib/kithmoot-node'], { stdio: 'inherit' })
  if (child.error) throw Error('Could not run the local node command')
  return child.status ?? 1
}
export async function operatorCommand(command: string, args: string[], bundle: string): Promise<void> {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) throw Error('System installation commands require root on Linux')
  const unlock = operationLock()
  try {
  const options = parse(args)
  if (command === 'resume') {
    if (options.size) throw Error('Recovery accepts no setup overrides')
    await resumeSystemNode(); console.log('Interrupted installation recovered; existing secrets retained.'); return
  }
  if (command === 'uninstall') {
    if ([...options.keys()].some(key => key !== '--delete-everything')) throw Error('Uninstall accepts only --delete-everything')
    uninstallSystemNode(options.has('--delete-everything')); console.log('Node services, managed state and certificate copies removed.'); return
  }
  if (command === 'update') {
    if (options.size) throw Error('Run update from the verified new release without setup overrides')
    console.log('Updating the node restarts its services and interrupts active calls.')
    await updateSystemNode(bundle); console.log('Node updated; existing ownership, grants and operation state retained.'); return
  }
  if (command === 'certificates') {
    if (!options.get('--certificate') || !options.get('--certificate-key') || [...options.keys()].some(key => !['--certificate', '--certificate-key'].includes(key))) throw Error('Use certificates --certificate FILE --certificate-key FILE')
    refreshSystemCertificates(String(options.get('--certificate')), String(options.get('--certificate-key'))); return
  }
  if (command !== 'install') throw Error('Unknown system installation command')
  verifyRelease(bundle); assertNewSystemInstall()
  const terminal = process.stdin.isTTY && process.stdout.isTTY
  const prompt = terminal ? createInterface({ input: process.stdin, output: process.stdout }) : undefined
  const ask = async (flag: string, question: string, fallback?: string): Promise<string> => {
    const value = options.get(flag)
    if (typeof value === 'string') return value
    if (!prompt) { if (fallback !== undefined) return fallback; throw Error(`Provide ${flag} for a non-interactive install`) }
    const answer = (await prompt.question(question + (fallback === undefined ? ': ' : ` [${fallback}]: `))).trim()
    if (!answer && fallback === undefined) throw Error(`${flag} requires an explicit choice`)
    return answer || fallback!
  }
  let input: Record<string, unknown>
  let suppliedCertificate: string | undefined, suppliedKey: string | undefined
  try {
    if (typeof options.get('--configuration') === 'string') input = JSON.parse(readFileSync(resolve(String(options.get('--configuration'))), 'utf8'))
    else input = {
      v: 1, host: (await ask('--name', 'Node DNS name')).toLowerCase(), hosting: await ask('--hosting', 'Hosting location (rented or archy; never home)'),
      relayIp: await ask('--relay-ip', 'IPv4 interface on this server'),
      aggregateBytesPerSecond: Number(await ask('--bandwidth', 'Aggregate relay limit in bytes per second')),
      maxBytes: Number(await ask('--storage-bytes', 'Maximum encrypted room storage in bytes')),
      minFreeBytes: Number(await ask('--min-free-bytes', 'Minimum free disk space to retain in bytes')),
      maxRooms: Number(await ask('--max-rooms', 'Maximum rooms (1 to 64)')),
      origins: (await ask('--origins', 'Allowed KithMoot HTTPS sites, comma separated', 'https://kithmoot.app,https://kithmoot.forgesworn.dev')).split(',').map(value => value.trim()),
      deskPort: 3746, spryPort: 3744, shelterPort: 3745,
    }
    if (typeof input.certificate === 'string') suppliedCertificate = input.certificate
    if (typeof input.certificateKey === 'string') suppliedKey = input.certificateKey
    if (typeof options.get('--public-ip') === 'string') input.publicIp = options.get('--public-ip')
    // Validate all resource and hosting choices before ACME or filesystem changes.
    input = validateConfiguration({ ...input, spryBinary: '/opt/kithmoot-node/current/bin/spry-node', shelterBinary: '/opt/kithmoot-node/current/bin/bothyd',
      certificate: '/etc/kithmoot-node/tls/fullchain.pem', certificateKey: '/etc/kithmoot-node/tls/privkey.pem' }) as unknown as Record<string, unknown>
    console.log('Whoever deploys it runs it. The node must be on a rented server or hosted Archy, never a home connection.')
    console.log('Required inbound IPv4 ports: TCP 443, TCP/UDP 3478, TCP 5349, UDP 49160–49191. DNS must name this server for both hostnames.')
    const firewall = await ask('--firewall', 'Host firewall (ufw or external)', 'external')
    if (!['ufw', 'external'].includes(firewall)) throw Error('Choose ufw or external firewall management')
    if (firewall === 'ufw') checkManagedFirewall()
    else console.log('Configure those ports in the host and provider firewall. This installer will preserve existing firewall rules.')
    let certificate: string, key: string, managedCertificate: string | undefined
    if (options.has('--acme')) {
      if (!options.has('--accept-acme-terms')) throw Error('ACME needs explicit --accept-acme-terms, or supply an existing certificate and key')
      console.log('ACME HTTP validation also needs inbound TCP 80; allow it in the host and provider firewall before issuance.')
      const name = acmeName(String(input.host))
      if (existsSync(`/etc/letsencrypt/live/${name}`)) throw Error('An existing ACME certificate must be supplied explicitly instead of overwritten')
      for (const [program, parameters] of [ ['apt-get', ['update']], ['apt-get', ['install', '-y', '--no-install-recommends', 'certbot']],
        ['certbot', ['certonly', '--standalone', '--non-interactive', '--agree-tos', '--register-unsafely-without-email', '--preferred-challenges', 'http', '--cert-name', name,
          '-d', String(input.host), '-d', `turn.${input.host}`]] ] as const) {
        const result = spawnSync(program, [...parameters], { stdio: 'inherit', timeout: 300000 })
        if (result.error || result.status !== 0) throw Error('Certificate setup failed; existing node data has not been replaced')
      }
      managedCertificate = name
      certificate = `/etc/letsencrypt/live/${name}/fullchain.pem`; key = `/etc/letsencrypt/live/${name}/privkey.pem`
    } else {
      certificate = resolve(await ask('--certificate', 'Existing certificate covering node and TURN hostnames', suppliedCertificate))
      key = resolve(await ask('--certificate-key', 'Its protected private key file', suppliedKey))
    }
    await installSystemNode(bundle, input, certificate, key, { ...(managedCertificate ? { acme: managedCertificate } : {}), ...(firewall === 'ufw' ? { firewall: 'ufw' } : {}) })
    if (managedCertificate) manageAcme(managedCertificate)
    if (firewall === 'ufw') manageFirewall()
  } finally { prompt?.close() }
  console.log('Local installation checks passed. Outside reachability and authenticated relay media still need another network.')
  if (terminal) { if (systemReadOnly('pair') !== 0) throw Error('Node installed; run the local pair command again') }
  else console.log('Run sudo /opt/kithmoot-node/current/kithmoot-node pair in a local terminal. Pairing codes are never written to service logs.')
  } finally { unlock() }
}
