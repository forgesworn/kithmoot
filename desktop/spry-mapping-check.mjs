import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createNatPmpClient } from './spry-natpmp.mjs'
import { diagnoseMappings, mappingPlan, summariseMappingDiagnostic } from './spry-mapping-diagnostic.mjs'

const HELP = `Usage: node desktop/spry-mapping-check.mjs --config /absolute/owner.json [--run] [--private-report /absolute/new.json]

Default: validate only; no network traffic. --run explicitly requests short-lived
inbound mappings for the chosen spare ports and one renewal after 45 seconds.
Use only an owner-reviewed VPN source/gateway, without another forwarding manager.
No Spry server, public advertisement, deletion, home-route fallback or credentials.
Mapping replies do not prove ownership, external reachability or VPN confinement.
Requests use a 60-second lease; stop/cancel stops renewal and leaves expiry to the
gateway. Existing mappings may be returned or renewed. Review your VPN/ISP terms
and applicable laws. --private-report writes identifying tuples to a new 0600 file.
`
const configError = () => Object.assign(new Error('Invalid mapping diagnostic configuration.'), { code: 'ERR_CONFIG' })

export async function loadMappingConfig(filePath) {
  if (typeof filePath !== 'string' || !isAbsolute(filePath)) throw configError()
  let file
  try {
    file = await open(filePath, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0))
    const info = await file.stat()
    if (!info.isFile() || info.size > 8192) throw configError()
    const buffer = Buffer.alloc(8193)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    if (bytesRead > 8192) throw configError()
    const value = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'))
    const keys = ['sourceIp', 'gatewayIp', 'listenPort', 'relayPorts']
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length
        || Object.keys(value).some(key => !keys.includes(key))) throw configError()
    mappingPlan(value)
    // Factory validation does no I/O and refuses non-private/wildcard/DNS addresses.
    createNatPmpClient(value)
    return value
  } catch { throw configError() }
  finally { await file?.close() }
}

export async function runMappingCheck(args, { output = value => process.stdout.write(`${JSON.stringify(value)}\n`), signal } = {}) {
  const flags = new Map()
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]
    if (!['--config', '--run', '--private-report'].includes(flag) || flags.has(flag)) throw configError()
    if (flag === '--run') flags.set(flag, true)
    else {
      const value = args[++index]
      if (!value || value.startsWith('--') || !isAbsolute(value)) throw configError()
      flags.set(flag, value)
    }
  }
  if (!flags.has('--config') || (flags.has('--private-report') && !flags.has('--run'))) throw configError()
  const config = await loadMappingConfig(flags.get('--config'))
  if (!flags.has('--run')) {
    output({ status: 'validated-only', networkRequests: 0, mappingCount: 2 + config.relayPorts.length, routeQualified: false })
    return 0
  }
  let privateFile
  try {
    // Refuse overwrite/symlink before requesting any live mappings.
    if (flags.has('--private-report')) privateFile = await open(flags.get('--private-report'), 'wx', 0o600)
    const report = await diagnoseMappings({ ...config, client: createNatPmpClient(config), signal })
    output(summariseMappingDiagnostic(report))
    if (privateFile) await privateFile.writeFile(`${JSON.stringify({ ...report, configuration: config }, null, 2)}\n`)
    return report.status === 'observed' ? 0 : 1
  } finally { await privateFile?.close() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.slice(2).length === 1 && ['--help', '-h'].includes(process.argv[2])) process.stdout.write(HELP)
  else {
    const controller = new AbortController()
    const cancel = () => controller.abort()
    process.on('SIGINT', cancel)
    process.on('SIGTERM', cancel)
    try { process.exitCode = await runMappingCheck(process.argv.slice(2), { signal: controller.signal }) }
    catch { process.stderr.write('Mapping check failed; inspect the owner configuration and private report path.\n'); process.exitCode = 1 }
    finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel) }
  }
}
