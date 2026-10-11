export class AdmissionPreviewCancelled extends Error {
  constructor(readonly requested: boolean) { super('Admission cancelled'); this.name = 'AbortError' }
}

/** Local device checks are separate from call-owned tracks. Every permission
 * completion checks its generation, including after cancellation or hiding. */
export class AdmissionPreview {
  readonly ready: Promise<void>
  #resolve!: () => void
  #reject!: (error: Error) => void
  #requested = false
  #closed = false
  #listeners = new AbortController()
  #cameraGeneration = 0
  #micGeneration = 0
  #camera?: MediaStream
  #mic?: MediaStream
  #audio?: AudioContext
  #meterTimer?: ReturnType<typeof setInterval>

  constructor(private view: {
    root: HTMLElement; name: HTMLInputElement; status: HTMLElement
    request: HTMLButtonElement; cancel: HTMLButtonElement
    camera: HTMLButtonElement; mic: HTMLButtonElement
    video: HTMLVideoElement; meter: HTMLMeterElement
    signal: AbortSignal; cancelRequest(): void
  }) {
    this.ready = new Promise((resolve, reject) => { this.#resolve = resolve; this.#reject = reject })
    const options = { signal: this.#listeners.signal }
    view.root.hidden = false
    view.request.disabled = false; view.request.textContent = 'Request to join'
    view.camera.disabled = false; view.mic.disabled = false
    view.name.readOnly = false
    this.phase('preview')
    view.request.addEventListener('click', () => this.request(), options)
    view.cancel.addEventListener('click', () => view.cancelRequest(), options)
    view.camera.addEventListener('click', () => { void this.camera() }, options)
    view.mic.addEventListener('click', () => { void this.microphone() }, options)
    view.signal.addEventListener('abort', () => {
      this.#reject(new AdmissionPreviewCancelled(this.#requested))
      this.stopMedia()
    }, options)
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.stopMedia() }, options)
    if (view.signal.aborted) this.#reject(new AdmissionPreviewCancelled(false))
  }

  request(): void {
    if (this.#requested || this.#closed || this.view.signal.aborted) return
    this.#requested = true
    this.stopMedia()
    this.view.name.readOnly = true
    this.view.request.disabled = true
    this.view.camera.disabled = true; this.view.mic.disabled = true
    this.#resolve()
  }
  get requested(): boolean { return this.#requested }

  phase(phase: 'preview' | 'preparing' | 'signing' | 'sending' | 'waiting' | 'reconnecting'): void {
    if (this.#closed || this.view.signal.aborted) return
    this.view.status.textContent = {
      preview: 'Check your name and devices. Nothing is sent to the room until you request to join.',
      preparing: 'Preparing your request…',
      signing: 'Waiting for your account to sign the request. You can cancel while your signer is open.',
      sending: 'Sending your request…',
      waiting: 'Your request reached a relay. Waiting for someone in the room to let you in.',
      reconnecting: 'Checking the connection and retrying the same request. This does not create another request.',
    }[phase]
    this.view.request.textContent = phase === 'preview' ? 'Request to join' : 'Requesting…'
    this.view.cancel.textContent = phase === 'preview' ? 'Close invitation' : 'Cancel request'
  }

  async camera(): Promise<void> {
    if (this.#camera) { this.stopCamera(); return }
    if (this.#requested || this.#closed || this.view.signal.aborted) return
    const generation = ++this.#cameraGeneration
    this.view.camera.disabled = true
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
      if (this.#closed || this.#requested || this.view.signal.aborted || document.hidden || generation !== this.#cameraGeneration) {
        stream.getTracks().forEach(track => track.stop()); return
      }
      this.#camera = stream
      this.view.video.srcObject = stream; this.view.video.hidden = false
      this.view.camera.textContent = 'Stop camera preview'
      await this.view.video.play()
      for (const track of stream.getTracks()) track.addEventListener('ended', () => { if (this.#camera === stream) this.stopCamera() }, { signal: this.#listeners.signal })
    } catch {
      if (!this.#closed && !this.view.signal.aborted && generation === this.#cameraGeneration) {
        this.stopCamera()
        this.view.status.textContent = 'Camera preview could not start. Check camera permission; you can still request to join.'
      }
    } finally { if (!this.#closed) this.view.camera.disabled = this.#requested }
  }

  async microphone(): Promise<void> {
    if (this.#mic) { this.stopMic(); return }
    if (this.#requested || this.#closed || this.view.signal.aborted) return
    const generation = ++this.#micGeneration
    this.view.mic.disabled = true
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
      if (this.#closed || this.#requested || this.view.signal.aborted || document.hidden || generation !== this.#micGeneration) {
        stream.getTracks().forEach(track => track.stop()); return
      }
      this.#mic = stream
      const audio = new AudioContext(); this.#audio = audio
      await audio.resume()
      if (generation !== this.#micGeneration || this.#closed || this.view.signal.aborted) return
      const source = audio.createMediaStreamSource(stream), analyser = audio.createAnalyser()
      analyser.fftSize = 256; source.connect(analyser)
      const samples = new Float32Array(256)
      this.view.meter.hidden = false; this.view.mic.textContent = 'Stop microphone test'
      this.#meterTimer = setInterval(() => {
        analyser.getFloatTimeDomainData(samples)
        this.view.meter.value = Math.min(1, Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length) * 3)
      }, 100)
      for (const track of stream.getTracks()) track.addEventListener('ended', () => { if (this.#mic === stream) this.stopMic() }, { signal: this.#listeners.signal })
    } catch {
      if (!this.#closed && !this.view.signal.aborted && generation === this.#micGeneration) {
        this.stopMic()
        this.view.status.textContent = 'Microphone test could not start. Check microphone permission; you can still request to join.'
      }
    } finally { if (!this.#closed) this.view.mic.disabled = this.#requested }
  }

  stopCamera(): void {
    ++this.#cameraGeneration
    this.#camera?.getTracks().forEach(track => track.stop()); this.#camera = undefined
    this.view.video.srcObject = null; this.view.video.hidden = true
    this.view.camera.textContent = 'Preview camera'
  }
  stopMic(): void {
    ++this.#micGeneration
    clearInterval(this.#meterTimer); this.#meterTimer = undefined
    this.#mic?.getTracks().forEach(track => track.stop()); this.#mic = undefined
    if (this.#audio) void this.#audio.close().catch(() => {})
    this.#audio = undefined
    this.view.meter.value = 0; this.view.meter.hidden = true
    this.view.mic.textContent = 'Test microphone'
  }
  stopMedia(): void { this.stopCamera(); this.stopMic() }
  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#reject(new AdmissionPreviewCancelled(this.#requested))
    this.stopMedia(); this.#listeners.abort()
    this.view.root.hidden = true; this.view.name.readOnly = false
  }
}
