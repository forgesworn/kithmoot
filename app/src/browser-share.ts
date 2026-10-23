import { browserSharePlan, type BrowserShareState } from './browser-share-plan.js'
import { moveSelection, resizeSelection, videoBox, WHOLE_PICTURE } from './share-area-geometry.js'
import type { AreaRect } from './share-area.js'
import { coverAll, coverFill } from './share-cover.js'

/** Explicit browser-local protected sharing. No raw track is ever returned. */
export class BrowserShare {
  #finish?: () => void
  constructor(private readonly ended: () => void) {}

  stop(): void { this.#finish?.() }

  start(area = false): Promise<MediaStream> {
    this.stop()
    const popup = window.open('about:blank#kithmoot-protected-share', '_blank', 'popup,width=1080,height=760')
    if (!popup) return Promise.reject(new Error('Allow the sharing preview window, then try again.'))
    const doc = popup.document
    doc.title = 'Prepare a protected share'
    const style = doc.createElement('style')
    style.textContent = `
      *{box-sizing:border-box}html,body{margin:0;height:100%;background:#101114;color:#fff;font:14px system-ui}
      body{display:flex;flex-direction:column}header,footer{padding:10px;display:flex;gap:8px;flex-wrap:wrap;align-items:center}
      button,select{font:inherit;padding:8px;color:inherit;background:#243445;border:1px solid #7794ac;border-radius:4px}
      button:disabled{opacity:.5}button[aria-pressed=true]{outline:2px solid #ffd21f}
      main{flex:1;min-height:120px;position:relative;overflow:hidden;background:#000}
      video{position:absolute;width:100%;height:100%;object-fit:contain}#selectionLayer{position:absolute;inset:0}
      .region{position:absolute;border:3px solid #ffd21f;touch-action:none;cursor:move;min-width:6px;min-height:6px}
      .crop{border-color:#4ecbff}.grip{position:absolute;right:-3px;bottom:-3px;padding:0;width:22px;height:22px;cursor:nwse-resize}
      #outgoing{width:220px;max-height:130px;object-fit:contain;background:#000;border:1px solid #7794ac}
      #status{flex:1;min-width:220px}small{display:block;padding:0 10px 8px;color:#bdcddd}button:focus-visible,.region:focus-visible{outline:3px solid #fff}
    `
    doc.head.append(style)
    const bar = doc.createElement('header')
    const button = (text: string) => { const el = doc.createElement('button'); el.type = 'button'; el.textContent = text; return el }
    const choose = button('Choose a window or tab')
    const cropMode = button('Adjust shared area')
    const add = button('Hide a region')
    const remove = button('Remove selected mask')
    const hide = button('Hide my share')
    const confirm = button('Start protected sharing')
    const stop = button('Cancel')
    for (const el of [cropMode, add, remove, hide, confirm]) el.disabled = true
    bar.append(choose, cropMode, add, remove, hide, confirm, stop)
    const stage = doc.createElement('main')
    // A raw preview in a captured surface can reproduce secrets outside a mask.
    // Keep it out of the document; all visible picture previews are protected.
    const video = doc.createElement('video'); video.muted = true; video.playsInline = true
    const sourcePreview = doc.createElement('canvas')
    sourcePreview.style.cssText = 'position:absolute;width:100%;height:100%;object-fit:contain'
    const layer = doc.createElement('div'); layer.id = 'selectionLayer'
    stage.append(sourcePreview, layer)
    const footer = doc.createElement('footer')
    const status = doc.createElement('span'); status.id = 'status'; status.setAttribute('role', 'status')
    status.textContent = 'Choose a source. Nothing is sent until you start sharing.'
    const output = doc.createElement('canvas'); output.id = 'outgoing'; output.width = 2; output.height = 2
    output.setAttribute('aria-label', 'Picture sent to friends')
    const warning = doc.createElement('small')
    warning.textContent = 'Blue selects what to share. Yellow masks hide fixed regions, not moving content. Masks do not hide sound. The small preview is the picture sent to friends.'
    footer.append(status, output)
    doc.body.replaceChildren(bar, stage, footer, warning)
    const context = output.getContext('2d')
    const previewContext = sourcePreview.getContext('2d')
    if (!context || !previewContext) { popup.close(); return Promise.reject(new Error('This browser cannot protect the shared picture.')) }
    coverAll(context, 2, 2)

    return new Promise<MediaStream>((resolve, reject) => {
      let raw: MediaStream | undefined, track: MediaStreamTrack | undefined
      let live = false, finished = false, choosing = false, failed = false
      let selected = -1, editCrop = area
      let initialSize: { width: number; height: number } | undefined
      let identity: string | undefined
      let generation = 0
      let resizeAwaitingConfirmation = false
      const state: BrowserShareState = { crop: { ...WHOLE_PICTURE }, masks: [], hidden: false, confirmedSize: { width: 0, height: 0 } }
      const masks: AreaRect[] = []; state.masks = masks
      let rejectPending = true
      const finish = (notify = false) => {
        if (finished) return
        finished = true
        clearInterval(timer)
        observer.disconnect()
        popup.removeEventListener('pagehide', closed)
        raw?.getTracks().forEach(t => t.stop())
        if (track) stopOutput?.()
        video.pause(); video.srcObject = null
        if (this.#finish === stopSession) this.#finish = undefined
        if (!popup.closed) popup.close()
        if (rejectPending) reject(new Error('Sharing cancelled.'))
        if (notify && live) this.ended()
      }
      const stopSession = () => finish()
      const closed = () => finish(true)
      this.#finish = stopSession
      popup.addEventListener('pagehide', closed)
      stop.onclick = closed
      let stopOutput: (() => void) | undefined
      const picture = () => videoBox(stage.clientWidth, stage.clientHeight, video.videoWidth, video.videoHeight)
      const layout = () => {
        layer.replaceChildren()
        const box = picture()
        if (!box || !raw) return
        const region = (rect: AreaRect, index: number, crop: boolean) => {
          const el = doc.createElement('div'); el.className = crop ? 'region crop' : 'region'
          el.tabIndex = 0
          el.setAttribute('role', 'group')
          el.setAttribute('aria-label', crop ? 'Shared area' : `Hidden region ${index + 1}`)
          Object.assign(el.style, { left: `${box.left + rect.x * box.width}px`, top: `${box.top + rect.y * box.height}px`,
            width: `${rect.width * box.width}px`, height: `${rect.height * box.height}px` })
          const grip = button('↘'); grip.className = 'grip'; grip.setAttribute('aria-label', crop ? 'Resize shared area' : `Resize hidden region ${index + 1}`)
          el.append(grip)
          const update = (next: AreaRect) => {
            if (crop) state.crop = next; else masks[index] = next
            // Keep a whole cover while editing; only explicit resume releases it.
            if (live) { state.hidden = true; hide.textContent = 'Show my share'; hide.setAttribute('aria-pressed', 'true') }
            paint(); layout()
          }
          const drag = (event: PointerEvent, resize: boolean) => {
            if (event.button !== 0) return
            event.preventDefault(); event.stopPropagation()
            selected = crop ? -1 : index; remove.disabled = crop
            const from = { ...rect }, x = event.clientX, y = event.clientY
            const target = event.currentTarget as HTMLElement
            target.setPointerCapture(event.pointerId)
            const move = (e: PointerEvent) => {
              const dx = (e.clientX - x) / box.width, dy = (e.clientY - y) / box.height
              const next = resize ? resizeSelection(from, 'se', dx, dy, { width: .01, height: .01 }) : moveSelection(from, dx, dy)
              // Do not rebuild the captured pointer's element during its drag.
              if (crop) state.crop = next; else masks[index] = next
              if (live) { state.hidden = true; hide.textContent = 'Show my share'; hide.setAttribute('aria-pressed', 'true') }
              Object.assign(el.style, { left: `${box.left + next.x * box.width}px`, top: `${box.top + next.y * box.height}px`, width: `${next.width * box.width}px`, height: `${next.height * box.height}px` })
              paint()
            }
            const end = () => { target.removeEventListener('pointermove', move); target.removeEventListener('pointerup', end); target.removeEventListener('pointercancel', end); target.removeEventListener('lostpointercapture', end); layout() }
            target.addEventListener('pointermove', move)
            for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) target.addEventListener(name, end, { once: true })
          }
          el.onpointerdown = e => drag(e, false); grip.onpointerdown = e => drag(e, true)
          const keys = (event: KeyboardEvent, resize: boolean) => {
            const d = { ArrowLeft: [-.01, 0], ArrowRight: [.01, 0], ArrowUp: [0, -.01], ArrowDown: [0, .01] }[event.key]
            if (!d) return
            event.preventDefault(); event.stopPropagation()
            update(resize ? resizeSelection(rect, 'se', d[0]!, d[1]!, { width: .01, height: .01 }) : moveSelection(rect, d[0]!, d[1]!))
            const label = crop ? 'Shared area' : `Hidden region ${index + 1}`
            const replacement = [...layer.querySelectorAll<HTMLElement>('[role=group]')].find(item => item.getAttribute('aria-label') === label)
            ;(resize ? replacement?.querySelector<HTMLButtonElement>('button') : replacement)?.focus()
          }
          el.onkeydown = e => keys(e, false); grip.onkeydown = e => keys(e, true)
          el.onfocus = () => { selected = crop ? -1 : index; remove.disabled = crop }
          layer.append(el)
        }
        if (editCrop) region(state.crop, -1, true)
        masks.forEach((mask, index) => region(mask, index, false))
      }
      const paint = () => {
        if (finished) return
        if (popup.closed) { finish(true); return }
        try {
          const source = raw?.getVideoTracks()[0]
          const settings = source?.getSettings()
          const device = source ? `${source.id}/${source.label}/${settings?.deviceId}/${settings?.displaySurface}` : undefined
          if (source && (source.readyState === 'ended' || source.muted)) {
            state.hidden = true
          }
          if (initialSize && (video.videoWidth !== initialSize.width || video.videoHeight !== initialSize.height || device !== identity)) {
            state.hidden = true
            resizeAwaitingConfirmation = true
            confirm.disabled = false
            confirm.textContent = 'Confirm changed source'
            hide.textContent = 'Show my share'; hide.setAttribute('aria-pressed', 'true')
          }
          const plan = failed ? { cover: true } as const : browserSharePlan(state, video.videoWidth, video.videoHeight)
          if (plan.cover) coverAll(context, output.width, output.height)
          else {
            if (output.width !== plan.width || output.height !== plan.height) { output.width = plan.width; output.height = plan.height }
            const r = plan.source
            context.drawImage(video, r.x, r.y, r.width, r.height, 0, 0, plan.width, plan.height)
            context.fillStyle = coverFill(context)
            for (const mask of plan.masks) context.fillRect(mask.x, mask.y, mask.width, mask.height)
          }
          const previewPlan = failed ? { cover: true } as const : browserSharePlan({ ...state, crop: WHOLE_PICTURE }, video.videoWidth, video.videoHeight)
          if (previewPlan.cover) coverAll(previewContext, sourcePreview.width, sourcePreview.height)
          else {
            if (sourcePreview.width !== previewPlan.width || sourcePreview.height !== previewPlan.height) {
              sourcePreview.width = previewPlan.width; sourcePreview.height = previewPlan.height
            }
            previewContext.drawImage(video, 0, 0, previewPlan.width, previewPlan.height)
            previewContext.fillStyle = coverFill(previewContext)
            for (const mask of previewPlan.masks) previewContext.fillRect(mask.x, mask.y, mask.width, mask.height)
          }
          if (track) (track as CanvasCaptureMediaStreamTrack).requestFrame()
          for (const audio of raw?.getAudioTracks() ?? []) audio.enabled = live && !state.hidden && !failed && !resizeAwaitingConfirmation
          if (raw) status.textContent = failed ? 'Protection failed. Stop and choose the source again.'
            : resizeAwaitingConfirmation ? 'The source changed. The share is covered; check the regions and confirm.'
            : state.hidden ? 'Hidden: friends receive a cover and no shared sound.'
            : live ? 'Sharing the protected preview. Edits hide the share until you show it again.'
            : 'Check the protected preview, then start sharing.'
        } catch {
          // If drawing or covering fails, ending the track is the safe fallback.
          failed = true
          finish(true)
        }
      }
      const observer = new ResizeObserver(layout); observer.observe(stage)
      const timer = setInterval(paint, 33)
      cropMode.onclick = () => { editCrop = !editCrop; cropMode.setAttribute('aria-pressed', String(editCrop)); layout() }
      cropMode.setAttribute('aria-pressed', String(editCrop))
      add.onclick = () => {
        if (live) state.hidden = true
        masks.push({ x: .35, y: .35, width: .3, height: .3 }); selected = masks.length - 1
        remove.disabled = false; paint(); layout()
        layer.querySelector<HTMLElement>(`[aria-label="Hidden region ${selected + 1}"]`)?.focus()
        if (state.hidden) { hide.textContent = 'Show my share'; hide.setAttribute('aria-pressed', 'true') }
      }
      remove.onclick = () => {
        if (selected < 0 || selected >= masks.length) return
        if (live) state.hidden = true
        masks.splice(selected, 1); selected = -1; remove.disabled = true
        paint(); layout()
        if (state.hidden) { hide.textContent = 'Show my share'; hide.setAttribute('aria-pressed', 'true') }
      }
      hide.onclick = () => {
        if (resizeAwaitingConfirmation) return
        state.hidden = !state.hidden; hide.textContent = state.hidden ? 'Show my share' : 'Hide my share'
        hide.setAttribute('aria-pressed', String(state.hidden)); paint()
      }
      confirm.onclick = () => {
        if (!raw || !video.videoWidth || !video.videoHeight || failed) return
        initialSize = { width: video.videoWidth, height: video.videoHeight }
        state.confirmedSize = { ...initialSize }
        const source = raw.getVideoTracks()[0]!
        const settings = source.getSettings()
        identity = `${source.id}/${source.label}/${settings.deviceId}/${settings.displaySurface}`
        resizeAwaitingConfirmation = false; state.hidden = false
        paint()
        if (finished) return
        if (!live) {
          try {
            track = output.captureStream(0).getVideoTracks()[0]
            if (!track || typeof (track as CanvasCaptureMediaStreamTrack).requestFrame !== 'function') {
              track?.stop(); track = undefined; finish(); return
            }
            stopOutput = track.stop.bind(track)
            track.stop = () => finish()
          } catch { finish(); return }
          live = true; rejectPending = false
          resolve(new MediaStream([track, ...raw.getAudioTracks()]))
        }
        hide.textContent = 'Hide my share'; hide.setAttribute('aria-pressed', 'false')
        confirm.disabled = true; confirm.textContent = 'Sharing protected preview'; stop.textContent = 'Stop sharing'
        paint()
      }
      choose.onclick = () => {
        if (choosing || raw) return
        choosing = true; choose.disabled = true
        const request = ++generation
        // The popup's own click supplies user activation to the browser picker.
        popup.navigator.mediaDevices.getDisplayMedia({ video: true, audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
          surfaceSwitching: 'exclude', selfBrowserSurface: 'exclude', monitorTypeSurfaces: 'exclude' } as DisplayMediaStreamOptions).then(async stream => {
          if (finished || popup.closed || request !== generation) { stream.getTracks().forEach(t => t.stop()); return }
          raw = stream
          const source = raw.getVideoTracks()[0]
          if (!source) throw new Error('No screen picture was provided.')
          const surface = source.getSettings().displaySurface
          // This browser path cannot establish monitor/window coordinates or
          // safely exclude its own controls from a monitor capture. Refuse,
          // rather than treating picker hints as an enforceable guarantee.
          if (!['window', 'browser'].includes(surface ?? '') || source.label.includes(doc.title)) {
            raw.getTracks().forEach(t => t.stop()); raw = undefined
            choosing = false; choose.disabled = false
            status.textContent = 'Choose another window or browser tab. Protected whole-screen and unknown-source capture need the desktop app.'
            return
          }
          for (const audio of raw.getAudioTracks()) audio.enabled = false
          source.addEventListener('ended', closed, { once: true })
          source.addEventListener('mute', () => { state.hidden = true; hide.textContent = 'Show my share'; paint() })
          video.srcObject = new MediaStream([source])
          await video.play()
          if (finished) return
          initialSize = { width: video.videoWidth, height: video.videoHeight }; state.confirmedSize = { ...initialSize }
          const settings = source.getSettings()
          identity = `${source.id}/${source.label}/${settings.deviceId}/${settings.displaySurface}`
          if (area) state.crop = { x: .1, y: .1, width: .8, height: .8 }
          choose.hidden = true
          for (const el of [cropMode, add, hide, confirm]) el.disabled = false
          paint(); layout()
        }).catch(() => {
          if (finished) return
          if (raw) { finish(); return }
          choosing = false; choose.disabled = false
          status.textContent = 'No source was chosen. Choose again or cancel.'
        })
      }
    })
  }
}
