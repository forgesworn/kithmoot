import { WIDTH as W, HEIGHT as H, MODEL_WIDTH as MW, MODEL_HEIGHT as MH,
  contain, nchw, grey, rectangle, checkedWeights, FrameGate } from './core.mjs'

const $ = id => document.getElementById(id)
const canvas = (w = W, h = H) => Object.assign(document.createElement('canvas'), { width: w, height: h })
const context = element => element.getContext('2d', { willReadFrequently: true })
const input = $('input'), output = $('output'), matte = $('matte'), editor = $('editor')
const video = $('source-video'), image = $('source-image'), small = canvas(MW, MH)
const label = canvas(), objects = canvas(), overlay = canvas(), alphaCanvas = canvas(MW, MH), foreground = canvas()
const gate = new FrameGate(), mask = new Image()
mask.src = './mask.svg'
let worker, workerReady = false, modelSerial = 0, sourceSerial = 0, sourceAbort = new AbortController()
let stream, blobUrl, kind = '', sequence = '', synthetic = false, example, sourceShape = '', sourceLoading = false
let room, frozen, lastResult, lastVideoTime = -1, dirty = true, lastCompleted = 0, processed = 0
let boxes = [], drag, samples = [], lastPointer, labelsLoading = false

const status = message => { $('status').textContent = message }
const blank = element => { context(element).clearRect(0, 0, element.width, element.height) }
const guard = callback => async event => { try { await callback(event) } catch (error) {
  if (error.name !== 'AbortError') status(error.message ?? String(error))
} }
const on = (id, event, callback) => $(id).addEventListener(event, guard(callback))
const uid = () => crypto.randomUUID()

function controls() {
  $('split').disabled = !!kind || sourceLoading
  $('facing').disabled = !!kind || sourceLoading
  $('camera').disabled = !!kind || sourceLoading
  $('stop').disabled = !kind && !sourceLoading
  $('reference').disabled = !kind || !!frozen
  $('clear-reference').disabled = !room
  $('capture').disabled = !kind || !!frozen
  $('resume').disabled = !frozen
  for (const id of ['undo-face', 'clear-labels']) $(id).disabled = !frozen || labelsLoading
  $('save-sample').disabled = !frozen || samples.length >= 32 || labelsLoading
  $('prediction-labels').disabled = !frozen || lastResult?.frame !== frozen || !lastResult?.alpha
  $('sample-labels').disabled = !frozen?.example || labelsLoading
  $('export').disabled = !samples.length
  $('play').hidden = kind !== 'video'
  $('reference-state').textContent = room ? 'Room reference in memory. It is cleared when the input changes.' : 'No room reference. Step out of view before capturing one.'
  $('samples-state').textContent = `${samples.length} of 32 samples in memory. ` + ['train', 'validation', 'test'].map(split => `${split}: ${samples.filter(s => s.split === split).length}`).join(' · ')
}

function modelRgb(picture) {
  context(overlay).putImageData(picture, 0, 0)
  context(small).drawImage(overlay, 0, 0, MW, MH)
  return nchw(context(small).getImageData(0, 0, MW, MH).data, MW, MH)
}

function resetInference() {
  gate.invalidate(); lastResult = undefined; dirty = true; lastVideoTime = -1; lastCompleted = 0
  blank(output); blank(matte)
  $('metrics').textContent = 'Waiting for this input’s prediction.'
  worker?.postMessage({ type: 'reset', epoch: gate.epoch,
    reference: room && $('use-reference').checked ? modelRgb(room.picture) : undefined,
    temporal: $('temporal').checked })
  controls()
}

function stopSource() {
  ++sourceSerial; sourceAbort.abort(); sourceAbort = new AbortController()
  stream?.getTracks().forEach(track => track.stop()); stream = undefined
  video.pause(); video.srcObject = null; video.removeAttribute('src'); video.load()
  image.removeAttribute('src')
  if (blobUrl) URL.revokeObjectURL(blobUrl)
  blobUrl = undefined; kind = ''; sourceLoading = false; labelsLoading = false; room = undefined; frozen = undefined; example = undefined; sourceShape = ''
  blank(input); blank(editor); resetInference(); controls()
}

function waitVideo(signal) {
  return new Promise((resolve, reject) => {
    const cleanup = () => { video.removeEventListener('loadeddata', done); video.removeEventListener('error', failed); signal.removeEventListener('abort', aborted) }
    const done = () => { cleanup(); resolve() }
    const failed = () => { cleanup(); reject(new Error('This browser could not decode the video')) }
    const aborted = () => { cleanup(); reject(new DOMException('Input changed', 'AbortError')) }
    video.addEventListener('loadeddata', done, { once: true }); video.addEventListener('error', failed, { once: true })
    signal.addEventListener('abort', aborted, { once: true })
  })
}

async function camera() {
  const facing = $('facing').value
  stopSource(); const own = sourceSerial; sourceLoading = true; controls()
  status('Requesting camera access. No microphone is requested.')
  try {
    const next = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: facing }, width: { ideal: 640 }, height: { ideal: 384 } }, audio: false })
    if (own !== sourceSerial) { next.getTracks().forEach(track => track.stop()); return }
    stream = next; video.srcObject = stream
    await video.play()
    if (own !== sourceSerial) return
    kind = 'camera'; sequence = 'camera-' + uid(); synthetic = false
    status('Camera is on locally. Capture an empty room or label a frame. Stop input ends capture.')
  } catch (error) { if (own !== sourceSerial) return; stopSource(); throw error
  } finally { if (own === sourceSerial) { sourceLoading = false; controls() } }
}

async function openFile(file) {
  stopSource(); const own = sourceSerial
  if (!file) return
  if (file.size > 32 * 1024 * 1024) throw new Error('Use an image or short clip up to 32 MiB')
  sourceLoading = true; controls()
  try {
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()))].map(v => v.toString(16).padStart(2, '0')).join('')
    if (own !== sourceSerial) return
    sequence = 'file-' + hash; synthetic = false; blobUrl = URL.createObjectURL(file)
    if (file.type.startsWith('video/') || /\.(mp4|webm|mov|m4v)$/i.test(file.name)) {
      const loaded = waitVideo(sourceAbort.signal); video.src = blobUrl; video.loop = true; await loaded
      if (own !== sourceSerial) return
      await video.play(); kind = 'video'
    } else { image.src = blobUrl; await image.decode(); if (own !== sourceSerial) return; kind = 'image' }
    status('Local file opened. Reusing a clip across held-out splits is refused by the importer.')
  } catch (error) { if (own !== sourceSerial) return; stopSource(); throw error
  } finally { if (own === sourceSerial) { sourceLoading = false; controls() } }
}

async function drawing() {
  const split = $('split').value
  stopSource(); const own = sourceSerial
  const response = await fetch('./examples.json')
  if (!response.ok) throw new Error('Prepare the local drawing examples first')
  const next = (await response.json()).find(item => item.split === split)
  image.src = next.rgb; await image.decode()
  if (own !== sourceSerial) return
  example = next; kind = 'image'; sequence = 'drawing-' + next.sequence; synthetic = true
  resetInference(); controls(); status('Original drawing sample. The default model was trained on drawings, not real people.')
}

function sourceFrame() {
  return { picture: context(input).getImageData(0, 0, W, H), sequence, split: $('split').value,
    synthetic, example, capturedAt: performance.now() }
}

function drawSource() {
  if (frozen) { context(input).putImageData(frozen.picture, 0, 0); return }
  if (!kind) return
  const source = kind === 'image' ? image : video
  const width = kind === 'image' ? image.naturalWidth : video.videoWidth
  const height = kind === 'image' ? image.naturalHeight : video.videoHeight
  if (!width || !height) return
  const shape = `${width}x${height}`
  if (sourceShape && shape !== sourceShape) { room = undefined; resetInference() }
  sourceShape = shape
  const box = contain(width, height)
  const ctx = context(input); ctx.fillStyle = '#080d12'; ctx.fillRect(0, 0, W, H)
  ctx.drawImage(source, box.x, box.y, box.width, box.height)
}

function renderPrediction(result) {
  const ctx = context(output), effect = $('effect').value
  context(overlay).putImageData(result.frame.picture, 0, 0)
  ctx.clearRect(0, 0, W, H); ctx.drawImage(overlay, 0, 0)
  if (result.alpha) {
    context(alphaCanvas).putImageData(new ImageData(grey(result.alpha, MW, MH), MW, MH), 0, 0)
    context(matte).drawImage(alphaCanvas, 0, 0, W, H)
    if (['replace', 'blur'].includes(effect)) {
      if (effect === 'blur') { ctx.save(); ctx.filter = 'blur(12px)'; ctx.drawImage(overlay, -12, -12, W + 24, H + 24); ctx.restore() }
      else { ctx.fillStyle = '#345361'; ctx.fillRect(0, 0, W, H) }
      const fg = context(foreground); fg.clearRect(0, 0, W, H); fg.drawImage(overlay, 0, 0)
      context(alphaCanvas).putImageData(new ImageData(grey(result.alpha, MW, MH, true), MW, MH), 0, 0)
      fg.globalCompositeOperation = 'destination-in'; fg.drawImage(alphaCanvas, 0, 0, W, H); fg.globalCompositeOperation = 'source-over'
      ctx.drawImage(foreground, 0, 0)
    }
  } else blank(matte)
  if (effect === 'mask' && !result.facesUsable) {
    ctx.fillStyle = '#101820'; ctx.fillRect(0, 0, W, H)
    if (mask.complete && mask.naturalWidth) ctx.drawImage(mask, (W - 120) / 2, 12, 120, H - 24)
  } else if (result.boxes) {
    for (let i = 0; i < result.boxes.length; i += 4) {
      const [x, y, w, h] = result.boxes.subarray(i, i + 4)
      if (effect === 'mask') {
        const left = Math.max(0, x - w * .2), top = Math.max(0, y - h * .2)
        const width = Math.min(1 - left, w * 1.4) * W, height = Math.min(1 - top, h * 1.4) * H
        ctx.fillStyle = '#101820'; ctx.fillRect(left * W, top * H, width, height)
        if (mask.complete && mask.naturalWidth) ctx.drawImage(mask, left * W, top * H, width, height)
      } else { ctx.strokeStyle = '#90f9cb'; ctx.lineWidth = 2; ctx.strokeRect(x * W, y * H, w * W, h * H) }
    }
  }
}

async function loadModel(bytes, card, own) {
  const hash = await checkedWeights(bytes, card)
  if (own !== modelSerial) return
  worker?.terminate(); gate.cancel(); workerReady = false; lastResult = undefined; blank(output); blank(matte)
  const next = new Worker('./worker.mjs', { type: 'module' }); worker = next
  next.onmessage = ({ data }) => {
    if (worker !== next) return
    if (data.type === 'error' && data.id === undefined) {
      workerReady = false; gate.cancel(); $('model-state').textContent = data.message; return
    }
    if (data.type === 'ready') {
      workerReady = true; resetInference()
      $('model-state').textContent = (card.scope === 'personal' ? 'Private personal experiment' : card.synthetic_only ? 'Procedural drawing model — not a real-face detector' : 'General experimental model — unqualified') + ` · ${card.format} · ${hash.slice(0, 16)} · ${(data.workspaceBytes / 1048576).toFixed(1)} MiB workspace`
    } else if (data.type === 'result' || data.type === 'error') {
      const frame = gate.finish(data)
      if (!frame) return
      if (data.type === 'error') { workerReady = false; blank(output); blank(matte); status(data.message); return }
      lastResult = { ...data, frame }
      try { renderPrediction(lastResult) } catch (error) {
        workerReady = false; lastResult = undefined; blank(output); blank(matte); status(error.message); return
      }
      processed++
      const now = performance.now(), fps = lastCompleted ? 1000 / (now - lastCompleted) : 0
      lastCompleted = now
      $('metrics').textContent = `${data.boxes ? data.boxes.length / 4 + ' faces' : 'Face task off'} · ${data.inferenceMs.toFixed(1)} ms inference · ${(now - frame.requestedAt).toFixed(1)} ms end-to-end · ${fps.toFixed(1)} processed fps · ${processed} frames · 160×96 inference`
      controls()
    }
  }
  next.onerror = () => { if (worker === next) { workerReady = false; gate.cancel(); status('Vision worker failed. Reload a local model to retry.'); blank(output); blank(matte) } }
  next.postMessage({ type: 'init', weights: bytes }, [bytes])
  next.postMessage({ type: 'reset', epoch: gate.epoch, reference: room && $('use-reference').checked ? modelRgb(room.picture) : undefined, temporal: $('temporal').checked })
}

async function defaultModel() {
  const own = ++modelSerial
  $('model-state').textContent = 'Loading the procedural smoke model…'
  const [weights, card] = await Promise.all([fetch('./default.kvm'), fetch('./default.json')])
  if (!weights.ok || !card.ok) throw new Error('Prepare local lab assets with npm run vision:lab -- --prepare')
  await loadModel(await weights.arrayBuffer(), await card.json(), own)
}

function resetReviews() { for (const id of ['faces-reviewed', 'foreground-reviewed', 'permission-reviewed']) $(id).checked = false }
function paintEditor() {
  blank(editor)
  if (!frozen) return
  const ctx = context(editor); ctx.putImageData(frozen.picture, 0, 0)
  ctx.save(); ctx.globalAlpha = .42; ctx.drawImage(label, 0, 0); ctx.restore()
  ctx.strokeStyle = '#93f9cc'; ctx.lineWidth = 2
  for (const [x, y, w, h] of boxes) ctx.strokeRect(x * W, y * H, w * W, h * H)
  if (drag) { const box = rectangle(drag.start, drag.end); if (box) ctx.strokeRect(box[0] * W, box[1] * H, box[2] * W, box[3] * H) }
}
function clearLabels() {
  boxes = []; drag = undefined; resetReviews()
  for (const c of [label, objects]) { const ctx = context(c); ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H) }
  paintEditor()
}
function capture() {
  if (!kind) return
  drawSource(); frozen = sourceFrame(); clearLabels(); resetInference(); controls()
  status('Captured frame is frozen for review. Camera remains on until Stop input. Inference now uses this captured frame.')
}
function position(event) { const box = editor.getBoundingClientRect(); return { x: (event.clientX - box.left) * W / box.width, y: (event.clientY - box.top) * H / box.height } }
function brush(a, b) {
  const tool = $('tool').value, size = Number($('brush').value)
  for (const [target, colour] of [[label, tool === 'erase' ? '#000' : '#fff'], [objects, tool === 'object' ? '#fff' : tool === 'erase' ? '#000' : null]]) {
    if (!colour) continue
    const ctx = context(target); ctx.strokeStyle = colour; ctx.fillStyle = colour; ctx.lineWidth = size * 2; ctx.lineCap = 'round'
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke()
    ctx.beginPath(); ctx.arc(b.x, b.y, size, 0, Math.PI * 2); ctx.fill()
  }
}
editor.addEventListener('pointerdown', event => {
  if (!frozen || labelsLoading) return
  editor.setPointerCapture(event.pointerId); resetReviews(); lastPointer = position(event)
  if ($('tool').value === 'face') drag = { start: lastPointer, end: lastPointer }
  else brush(lastPointer, lastPointer)
  paintEditor()
})
editor.addEventListener('pointermove', event => {
  if (!lastPointer || !frozen) return
  const next = position(event)
  if (drag) drag.end = next
  else brush(lastPointer, next)
  lastPointer = next; paintEditor()
})
function finishPointer() {
  if (drag) { const box = rectangle(drag.start, drag.end); if (box && boxes.length < 32) boxes.push(box) }
  drag = undefined; lastPointer = undefined; paintEditor()
}
editor.addEventListener('pointerup', finishPointer)
editor.addEventListener('pointercancel', () => { drag = undefined; lastPointer = undefined; paintEditor() })

on('camera', 'click', camera)
on('stop', 'click', () => { stopSource(); status('Input stopped. Saved samples remain in memory until export or Clear lab.') })
on('input-file', 'change', event => openFile(event.target.files[0]))
on('sample', 'click', drawing)
on('play', 'click', () => video.paused ? video.play() : video.pause())
on('reference', 'click', () => { drawSource(); room = { picture: context(input).getImageData(0, 0, W, H) }; resetInference() })
on('clear-reference', 'click', () => { room = undefined; resetInference() })
for (const id of ['use-reference', 'temporal', 'task']) on(id, 'change', resetInference)
on('effect', 'change', () => { if (lastResult) renderPrediction(lastResult) })
on('default-model', 'click', defaultModel)
on('load-model', 'click', async () => {
  const weights = $('model-file').files[0], card = $('model-card').files[0], own = ++modelSerial
  if (!weights || !card || card.size > 65536 || weights.size > 121000) throw new Error('Choose both a .kvm export and its small .json export card')
  await loadModel(await weights.arrayBuffer(), JSON.parse(await card.text()), own)
})
on('capture', 'click', capture)
on('resume', 'click', () => { frozen = undefined; blank(editor); resetInference(); controls() })
on('clear-labels', 'click', clearLabels)
on('undo-face', 'click', () => { boxes.pop(); resetReviews(); paintEditor() })
on('prediction-labels', 'click', () => {
  if (!frozen || lastResult?.frame !== frozen || !lastResult.alpha) return
  context(alphaCanvas).putImageData(new ImageData(grey(lastResult.alpha, MW, MH), MW, MH), 0, 0)
  context(label).drawImage(alphaCanvas, 0, 0, W, H); resetReviews(); paintEditor()
})
on('sample-labels', 'click', async () => {
  const target = frozen
  if (!target?.example) return
  labelsLoading = true; controls()
  try {
    const pictures = await Promise.all(['alpha', 'held_objects'].map(async name => { const img = new Image(); img.src = target.example[name]; await img.decode(); return img }))
    if (target !== frozen) return
    boxes = target.example.faces.map(box => [...box]); context(label).drawImage(pictures[0], 0, 0, W, H); context(objects).drawImage(pictures[1], 0, 0, W, H)
    resetReviews(); paintEditor(); status('Drawing labels loaded. Review the faces, foreground and local permission before adding.')
  } finally { if (target === frozen) labelsLoading = false; controls() }
})
on('save-sample', 'click', () => {
  if (!frozen || samples.length >= 32 || labelsLoading) return
  if (!['faces-reviewed', 'foreground-reviewed', 'permission-reviewed'].every(id => $(id).checked)) throw new Error('Review every face, the foreground/objects and local permission before adding this sample')
  context(overlay).putImageData(frozen.picture, 0, 0)
  const item = { id: uid(), sequence: frozen.sequence, split: frozen.split, synthetic: frozen.synthetic,
    rgb: overlay.toDataURL('image/png'), alpha: label.toDataURL('image/png'), held_objects: objects.toDataURL('image/png'),
    faces: boxes.map(box => [...box]), facesComplete: true, foregroundReviewed: true, permissionReviewed: true }
  if (room) { context(overlay).putImageData(room.picture, 0, 0); item.reference = overlay.toDataURL('image/png') }
  samples.push(item); resetReviews(); controls(); status('Reviewed sample added locally. Export to keep it, or Clear lab to delete it from this tab.')
})
on('export', 'click', () => {
  const bytes = JSON.stringify({ format: 'kithmoot-vision-captures-v1', scope: 'personal', publicReleasePermission: false, samples })
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/json' })), link = document.createElement('a')
  link.href = url; link.download = `kithmoot-vision-${Date.now()}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
})
on('reset', 'click', async () => {
  stopSource(); worker?.terminate(); worker = undefined; workerReady = false; gate.cancel(); ++modelSerial
  samples = []; boxes = []; lastResult = undefined; room = undefined; processed = 0; lastCompleted = 0
  for (const id of ['input-file', 'model-file', 'model-card']) $(id).value = ''
  clearLabels(); controls(); await defaultModel(); status('Lab cleared. Camera stopped; captures, personal model and room reference released from this tab. Exported files are separate.')
})
window.addEventListener('pagehide', () => { stopSource(); worker?.terminate() })

function tick() {
  try {
    drawSource()
    const time = kind === 'image' || frozen ? 0 : video.currentTime
    if (kind && workerReady && !gate.pending && (dirty || (!frozen && kind !== 'image' && time !== lastVideoTime))) {
      const frame = frozen ?? sourceFrame(); frame.requestedAt = performance.now()
      const request = gate.begin(frame)
      const rgb = modelRgb(frame.picture)
      worker.postMessage({ type: 'frame', ...request, rgb, tasks: $('task').value }, [rgb.buffer])
      dirty = false; lastVideoTime = time
    }
  } catch (error) { status(error.message); workerReady = false; gate.cancel() }
  requestAnimationFrame(tick)
}
controls(); requestAnimationFrame(tick)
void defaultModel().catch(error => { $('model-state').textContent = error.message })
