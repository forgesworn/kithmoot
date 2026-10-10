/** Browser-side collection. Never export candidate addresses or room identity. */
export async function performanceSample() {
  const peers = (window as unknown as { __pcs?: RTCPeerConnection[] }).__pcs ?? []
  const connections = await Promise.all(peers.map(async (pc, connection) => {
    const streams: Record<string, unknown>[] = []
    const paths: Record<string, unknown>[] = []
    let error: string | null = null
    try {
      const report = await pc.getStats()
      const byId = new Map<string, Record<string, unknown>>()
      const selected = new Set<string>()
      report.forEach(row => {
        byId.set(row.id, row)
        if (row.type === 'transport' && row.selectedCandidatePairId) selected.add(row.selectedCandidatePairId)
      })
      report.forEach(row => {
        if (row.type === 'inbound-rtp' || row.type === 'outbound-rtp') {
          const stream: Record<string, unknown> = { series: `${connection}:${row.type}:${row.id}`, direction: row.type, kind: row.kind }
          for (const key of ['bytesReceived', 'bytesSent', 'packetsReceived', 'packetsSent', 'packetsLost', 'framesDecoded', 'framesEncoded', 'framesPerSecond', 'frameWidth', 'frameHeight', 'jitter', 'jitterBufferDelay', 'jitterBufferEmittedCount', 'totalAudioEnergy', 'totalSamplesDuration', 'totalEncodeTime', 'totalDecodeTime', 'freezeCount', 'totalFreezesDuration', 'qualityLimitationReason']) {
            if (typeof row[key] === 'number' || typeof row[key] === 'string') stream[key] = row[key]
          }
          const codec = byId.get(row.codecId)
          if (codec?.mimeType) stream.codec = codec.mimeType
          streams.push(stream)
        }
        if (row.type === 'candidate-pair' && selected.has(row.id)) {
          const local = byId.get(row.localCandidateId)
          const remote = byId.get(row.remoteCandidateId)
          paths.push({ state: row.state, localType: local?.candidateType ?? null, remoteType: remote?.candidateType ?? null, protocol: local?.protocol ?? null, relayProtocol: local?.relayProtocol ?? null, roundTripSeconds: row.currentRoundTripTime ?? null, bytesSent: row.bytesSent ?? null, bytesReceived: row.bytesReceived ?? null })
        }
      })
    } catch { error = 'getStats failed' }
    return { connection, state: pc.connectionState, streams, paths, error }
  }))
  const videos = Array.from(document.querySelectorAll<HTMLVideoElement>('#room video, .shareViewer video')).map((video, index) => {
    const frames = video.getVideoPlaybackQuality?.()
    const rect = video.getBoundingClientRect()
    return { index, width: video.videoWidth, height: video.videoHeight, time: video.currentTime, paused: video.paused, readyState: video.readyState, visible: rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight, frames: frames?.totalVideoFrames ?? null, dropped: frames?.droppedVideoFrames ?? null }
  })
  return { atMs: performance.now(), visibility: document.visibilityState, connections, videos }
}
