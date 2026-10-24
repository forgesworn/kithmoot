#!/usr/bin/env node
// Independent operator process. No room/media keys, capture or recording API.
import { readFileSync, lstatSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { RealtimeServiceHost, REALTIME_PACKET_LIFETIME_MS } from '../src/realtime/service.js'
import type { TransportRuntime, ServiceIce } from '../src/realtime/index.js'
import { startOperatorLifecycle } from './operator-lifecycle.js'

async function main(): Promise<void> {
  // No inherited dependency diagnostics in this private operator process.
  if (process.env.DEBUG || process.env.NODE_DEBUG) throw new Error('Debug logging must be disabled')
  const path = process.argv[2]
  if (!path) throw new Error('An operator configuration file is required')
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) || stat.size > 16_384) throw new Error('Configuration must be a private regular file')
  const config = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  const keys = ['relays', 'namespace', 'secretKey', 'allowedClients', 'iceServers', 'iceTransportPolicy', 'maxPeers', 'advertise']
  if (Object.keys(config).some(k => !keys.includes(k)) || !Array.isArray(config.allowedClients)
    || typeof config.secretKey !== 'string' || !/^[0-9a-f]{64}$/.test(config.secretKey)
    || typeof config.namespace !== 'string' || !Array.isArray(config.relays) || !Array.isArray(config.iceServers)
    || !['all', 'relay'].includes(String(config.iceTransportPolicy))) throw new Error('Invalid operator configuration')
  const base = resolve(dirname(fileURLToPath(import.meta.url)), 'realtime-runtime/transport.mjs')
  const runtime = await import(pathToFileURL(base).href) as TransportRuntime
  type Backend = { RTCPeerConnectionImpl: ServiceIce['RTCPeerConnectionImpl']; disposeForProcessExit(): void }
  const nativeFactory = await import(pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), 'realtime-runtime/native-backend.mjs')).href) as {
    createNativeRealtimeBackend(options: { nodeDataChannel: unknown; packageVersion: string; maxPacketLifeTimeMs: number; maxPeers: number }): Promise<Backend>
  }
  const nativeDirectory = resolve(dirname(fileURLToPath(import.meta.url)), 'realtime-runtime/native')
  const metadata = JSON.parse(readFileSync(resolve(nativeDirectory, 'native-addon.json'), 'utf8'))
  const nativePath = resolve(nativeDirectory, 'native-addon.node')
  if (metadata.format !== 1 || metadata.platform !== process.platform || metadata.arch !== process.arch
    || metadata.bindingVersion !== '0.33.4' || metadata.libraryVersion !== '0.24.5-forgesworn-turn-close.1'
    || metadata.sourceModified !== true || createHash('sha256').update(readFileSync(nativePath)).digest('hex') !== metadata.files?.['native-addon.node']) {
    throw new Error('Native realtime build is missing or mismatched')
  }
  // Load only the prepared sidecar. A stock npm prebuild lacks TURN release.
  const native = createRequire(import.meta.url)(nativePath)
  const pool = new runtime.RelayPool(config.relays as string[])
  await startOperatorLifecycle({
    pool,
    signals: process,
    createBackend: () => nativeFactory.createNativeRealtimeBackend({ nodeDataChannel: native, packageVersion: metadata.bindingVersion,
      maxPacketLifeTimeMs: REALTIME_PACKET_LIFETIME_MS, maxPeers: 64 }),
    createSession: () => new runtime.RelaySwarmSession({ pool, swarmId: config.namespace as string,
      secretKey: Uint8Array.from((config.secretKey as string).match(/../g)!, v => parseInt(v, 16)) }),
    createHost: (session, backend) => new RealtimeServiceHost(runtime, session, new Set(config.allowedClients as string[]), {
      iceServers: config.iceServers as RTCIceServer[], iceTransportPolicy: config.iceTransportPolicy as RTCIceTransportPolicy,
      RTCPeerConnectionImpl: backend.RTCPeerConnectionImpl }, config.maxPeers as number | undefined),
    advertise: config.advertise === true,
    // A readiness line, never a per-call/client/packet log.
    ready: () => { process.stdout.write('Realtime operator ready\n') },
  })
}
void main().catch(() => { process.stderr.write('Realtime operator stopped; check private configuration\n'); process.exitCode = 1 })
