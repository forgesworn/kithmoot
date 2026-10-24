import type { DatagramSender } from './forwarder.js'

export interface QueueMetadata { stream: number; video: boolean; key: boolean; sequence: number; deadlineMs: number }
export interface CiphertextQueue {
  offer(meta: QueueMetadata, data: Uint8Array, nowMs: number): { accepted: boolean; dropped: number; waitingForKeyframe: boolean }
  pop(nowMs: number): ({ metadata: QueueMetadata; ciphertext: Uint8Array } | null | undefined)
  tick(nowMs: number): unknown
  waitingForKeyframe(stream: number): boolean
  close(): unknown
}
export interface QueueLimits { maxBytes: number; maxFrames: number; maxStreams: number; maxResidenceMs: number }
export type QueueFactory = (limits: QueueLimits) => Promise<CiphertextQueue>
export interface SignalEvent { from: string; payload: { type: string; transport: string; requestId: string; payload: Record<string, unknown> }; event?: { created_at: number } }
export interface SwarmSession {
  pubkey: string
  start(): void
  close(): void
  onSignal(fn: (event: SignalEvent) => void): () => void
  sendSignal(to: string, signal: { type: string; transport: string; requestId: string; payload: Record<string, unknown> }): unknown
  onPresence(fn: (event: { from: string; event: { created_at: number }; payload: { role: string; open?: boolean; transports: { type: string; publicKey: string }[] } }) => void): () => void
  announcePresence(value: { role: string; transports: { type: string; publicKey: string }[]; open: boolean }): unknown
}
export interface RealtimePeer extends DatagramSender {
  ready: Promise<unknown>
  start(): Promise<unknown>
  snapshot(): Record<string, unknown>
  pc: RTCPeerConnection
}
export interface TransportRuntime {
  RelayPool: new (urls: string[]) => { connect(): Promise<void>; close(): void }
  RelaySwarmSession: new (options: { pool: unknown; swarmId: string; secretKey?: Uint8Array }) => SwarmSession
  RealtimePeer: new (options: { session: SwarmSession; peerPubkey: string; initiator: boolean; iceServers: RTCIceServer[];
    iceTransportPolicy: RTCIceTransportPolicy; onDatagram: (data: Uint8Array) => void; onClose?: () => void; requestId?: string;
    timeoutMs?: number; maxPacketLifeTimeMs?: number; RTCPeerConnectionImpl?: typeof RTCPeerConnection }) => RealtimePeer
}

/** Generated assets come from the explicitly prepared, reviewed suite sources.
 * No CDN, provider default, remote directory or silent alternate media path. */
export async function loadRealtimeRuntime(base: URL): Promise<{ transport: TransportRuntime; queueFactory: QueueFactory }> {
  if (!['http:', 'https:', 'file:'].includes(base.protocol)) throw new Error('Invalid realtime runtime location')
  if (typeof location !== 'undefined' && base.origin !== location.origin) throw new Error('Realtime code must come from the application origin')
  const transportUrl = new URL('transport.mjs', base).href
  const sapflowUrl = new URL('sapflow.mjs', base).href
  const transport = await import(/* @vite-ignore */ transportUrl) as TransportRuntime
  const sapflow = await import(/* @vite-ignore */ sapflowUrl) as { createRealtimeQueue: (bytes: Uint8Array, limits: QueueLimits) => Promise<CiphertextQueue> }
  const response = await fetch(new URL('sapflow_realtime_bg.wasm', base), { signal: AbortSignal.timeout(10_000) })
  if (!response.ok || !response.body || Number(response.headers.get('content-length')) > 1_048_576) throw new Error('Realtime queue runtime unavailable')
  const chunks: Uint8Array[] = [], reader = response.body.getReader()
  let size = 0
  try {
    for (;;) {
      const value = await reader.read()
      if (value.done) break
      size += value.value.length
      if (size > 1_048_576) { await reader.cancel(); throw new Error('Realtime queue runtime exceeds its bound') }
      chunks.push(value.value)
    }
  } finally { reader.releaseLock() }
  const bytes = new Uint8Array(size); let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  return { transport, queueFactory: limits => sapflow.createRealtimeQueue(bytes, limits) }
}
