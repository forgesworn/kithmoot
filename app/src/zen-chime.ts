/** An original, softly struck bowl tone. No downloaded sound or remote media. */
let audio: AudioContext | undefined
let lastBell = -Infinity
export async function unlockZenChime(): Promise<void> {
  try { audio ??= new AudioContext(); if (audio.state === 'suspended') await audio.resume() } catch { /* Device may have no audio output. */ }
}
export async function playZenChime(preview = false): Promise<void> {
  const now = performance.now()
  if (!preview && now - lastBell < 5000) return
  lastBell = now
  try {
    audio ??= new AudioContext()
    if (audio.state === 'suspended') await audio.resume()
    if (audio.state !== 'running') return
    const start = audio.currentTime
    for (const [frequency, level, decay] of [[523.25, 0.11, 2.2], [1049.6, 0.035, 1.5], [1467, 0.015, 0.8]]) {
      const oscillator = audio.createOscillator()
      const gain = audio.createGain()
      oscillator.type = 'sine'
      oscillator.frequency.value = frequency!
      gain.gain.setValueAtTime(0, start)
      gain.gain.linearRampToValueAtTime(level!, start + 0.012)
      gain.gain.exponentialRampToValueAtTime(0.0001, start + decay!)
      oscillator.connect(gain).connect(audio.destination)
      oscillator.start(start)
      oscillator.stop(start + decay! + 0.05)
      oscillator.onended = () => { oscillator.disconnect(); gain.disconnect() }
    }
  } catch { /* Audio availability must never interrupt messaging. */ }
}
