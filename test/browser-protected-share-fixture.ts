import type { Page } from '@playwright/test'

/** Synthetic private marker at the centre, allowed green at the edges. */
export async function syntheticSource(popup: Page): Promise<void> {
  await popup.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360
    const context = canvas.getContext('2d')!
    const paint = () => {
      context.fillStyle = '#00dd00'; context.fillRect(0, 0, canvas.width, canvas.height)
      context.fillStyle = '#ff0000'; context.fillRect(canvas.width * .4, canvas.height * .4, canvas.width * .2, canvas.height * .2)
    }
    paint(); const timer = setInterval(paint, 25)
    const stream = canvas.captureStream(30)
    const source = stream.getVideoTracks()[0]!
    const settings = source.getSettings.bind(source)
    source.getSettings = () => ({ ...settings(), displaySurface: 'window' }) as MediaTrackSettings
    const audio = new AudioContext(); const osc = audio.createOscillator(); osc.frequency.value = 440
    const dest = audio.createMediaStreamDestination(); osc.connect(dest); osc.start()
    stream.addTrack(dest.stream.getAudioTracks()[0]!)
    const originalStop = stream.getVideoTracks()[0]!.stop.bind(stream.getVideoTracks()[0]!)
    stream.getVideoTracks()[0]!.stop = () => { clearInterval(timer); originalStop(); osc.stop(); void audio.close() }
    Object.assign(window, { raw: stream, sourceCanvas: canvas })
    navigator.mediaDevices.getDisplayMedia = async () => stream
  })
}
