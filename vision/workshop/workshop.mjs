/** MIT local-only source review and frame annotation for KithMoot models. */
const $ = id => document.getElementById(id)
const FORMAT = 'kithmoot-model-workshop-v1', PROJECT = 'kithmoot-model-workshop-project-v1'
const video = $('video'), still = $('still'), editor = $('editor'), ctx = editor.getContext('2d')
const picture = document.createElement('canvas'), alpha = document.createElement('canvas'), objects = document.createElement('canvas')
let sources = [], samples = [], active, file, fileHash, fileURL, frame, faces = [], drag, lastPoint, editing, busy = false, sourceSerial = 0, annotationSerial = 0
const uid = () => crypto.randomUUID()
const status = message => { $('status').textContent = message }
const tasks = () => ({ faces: $('tasks').value !== 'foreground', foreground: $('tasks').value !== 'faces' })
const run = action => async event => { try { await action(event) } catch (error) { status(error.message) } }
const on = (id, event, action) => $(id).addEventListener(event, run(action))
const safeURL = value => { const u = new URL(value); if (!['https:', 'http:'].includes(u.protocol)) throw new Error('Use an HTTP(S) source/evidence URL.'); return u.href }

function controls() {
  $('capture').disabled = !active || busy
  $('approve-source').disabled = !file || !!active || busy
  for (const id of ['save-frame', 'undo-face', 'clear-labels', 'alpha-file']) $(id).disabled = !frame || busy
  $('faces-reviewed').disabled = !tasks().faces
  $('foreground-reviewed').disabled = !tasks().foreground
  $('export-training').disabled = !samples.length || busy
  $('sample-state').textContent = samples.length + ' of 24 frames in this review. ' + ['train', 'validation', 'test'].map(split => split + ': ' + samples.filter(sample => sources.find(source => source.id === sample.source)?.split === split).length).join(' · ')
}
function resetReviews() { $('faces-reviewed').checked = false; $('foreground-reviewed').checked = false }
function releaseFile() {
  video.pause(); video.removeAttribute('src'); video.load(); still.removeAttribute('src')
  video.hidden = true; still.hidden = true
  if (fileURL) URL.revokeObjectURL(fileURL)
  fileURL = undefined; file = undefined; fileHash = undefined; active = undefined
}
function clearFrame() {
  ++annotationSerial
  busy = false
  frame = undefined; editing = undefined; faces = []; drag = undefined; lastPoint = undefined
  ctx.clearRect(0, 0, editor.width, editor.height); resetReviews()
  for (const canvas of [picture, alpha, objects]) { canvas.width = 16; canvas.height = 16 }
}
function blankLabels() {
  for (const canvas of [alpha, objects]) { const c = canvas.getContext('2d'); c.fillStyle = 'black'; c.fillRect(0, 0, canvas.width, canvas.height) }
}
function render() {
  if (!frame) return
  ctx.clearRect(0, 0, editor.width, editor.height); ctx.drawImage(picture, 0, 0)
  if (tasks().foreground) {
    const values = alpha.getContext('2d').getImageData(0, 0, alpha.width, alpha.height)
    const overlay = ctx.createImageData(alpha.width, alpha.height)
    for (let i = 0; i < values.data.length; i += 4) { overlay.data[i] = 10; overlay.data[i + 1] = 210; overlay.data[i + 2] = 180; overlay.data[i + 3] = Math.round(values.data[i] * .42) }
    const temporary = document.createElement('canvas'); temporary.width = alpha.width; temporary.height = alpha.height
    temporary.getContext('2d').putImageData(overlay, 0, 0); ctx.drawImage(temporary, 0, 0)
  }
  if (tasks().faces) {
    ctx.strokeStyle = '#ffb020'; ctx.lineWidth = Math.max(2, editor.width / 300)
    for (const [x, y, w, h] of faces) ctx.strokeRect(x * editor.width, y * editor.height, w * editor.width, h * editor.height)
    if (drag) ctx.strokeRect(drag.start.x, drag.start.y, drag.end.x - drag.start.x, drag.end.y - drag.start.y)
  }
  controls()
}
async function loaded(element, url, type) {
  await new Promise((resolve, reject) => {
    const done = () => { clean(); resolve() }, fail = () => { clean(); reject(new Error('This browser could not decode the local file. Try a supported MP4 or PNG.')) }
    const clean = () => { element.removeEventListener(type, done); element.removeEventListener('error', fail) }
    element.addEventListener(type, done, { once: true }); element.addEventListener('error', fail, { once: true }); element.src = url
  })
}
async function openFile() {
  const next = $('footage').files[0]; if (!next) return
  if (next.size > 128 * 1024 * 1024) throw new Error('Use a clip or image no larger than 128 MiB.')
  if (!/^(video\/|image\/(png|jpeg|webp)$)/.test(next.type)) throw new Error('Choose a local video, PNG, JPEG or WebP.')
  const serial = ++sourceSerial; releaseFile(); clearFrame(); busy = true; controls()
  $('source-fields').disabled = false; $('source-form').reset()
  $('file-state').textContent = 'Hashing and opening the local source…'
  try {
    const bytes = await next.arrayBuffer()
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('')
    if (serial !== sourceSerial) return
    const url = URL.createObjectURL(next)
    fileURL = url
    const element = next.type.startsWith('video/') ? video : still
    await loaded(element, url, element === video ? 'loadeddata' : 'load')
    if (serial !== sourceSerial) return
    file = next; fileHash = hash; element.hidden = false
    $('title').value = next.name
    $('file-state').textContent = next.name + ' · SHA-256 ' + hash
    $('source-state').textContent = 'Review the rights and split groups for this exact file.'
    status('Source opened locally. Review its permission evidence before capturing training frames.')
  } finally { if (serial === sourceSerial) { busy = false; controls() } }
}
async function approve(event) {
  event.preventDefault()
  if (!file || active || !$('source-form').reportValidity()) return
  const licence = $('licence').value
  if (licence === 'PUBLIC-DOMAIN-REVIEWED' && !$('pd-basis').value.trim()) throw new Error('Record the public-domain basis and scope.')
  const subjects = $('subjects').value.split(',').map(value => value.trim()).filter(Boolean)
  if (!subjects.length) throw new Error('Record opaque subject group IDs, using the same IDs for recurring people.')
  active = { id: uid(), title: $('title').value.trim(), filename: file.name, sha256: fileHash, status: 'approved',
    url: safeURL($('url').value), licence, reviewer: $('reviewer').value.trim(), reviewed_at: new Date().toISOString(),
    terms: $('terms').value.trim(), permission_basis: $('permission-basis').value.trim(), public_domain_basis: $('pd-basis').value.trim(),
    subjects, scene: $('scene').value.trim(), sequence: $('sequence').value.trim(), split: $('split').value,
    synthetic: $('synthetic').checked, training: true, commercial: true, mit_weights: true, subject_permission: true }
  sources.push(active); $('source-fields').disabled = true
  $('source-state').textContent = 'Source review saved in memory for ' + active.split + '. Export the review to keep it.'
  controls()
}
function capture() {
  if (!active || busy) return
  video.pause()
  const source = video.hidden ? still : video
  const width = source === video ? video.videoWidth : still.naturalWidth, height = source === video ? video.videoHeight : still.naturalHeight
  if (!width || !height) throw new Error('Wait for a decoded frame.')
  const scale = Math.min(1, 1280 / width, 960 / height)
  const targetWidth = Math.round(width * scale), targetHeight = Math.round(height * scale)
  if (Math.min(targetWidth, targetHeight) < 16) throw new Error('This source is too narrow for training. Preserve at least 16 pixels on each edge.')
  for (const canvas of [editor, picture, alpha, objects]) { canvas.width = targetWidth; canvas.height = targetHeight }
  picture.getContext('2d').drawImage(source, 0, 0, picture.width, picture.height)
  frame = { id: uid(), source: active.id, time: source === video ? video.currentTime : 0 }
  editing = undefined; faces = []; blankLabels(); resetReviews()
  $('frame-state').textContent = active.title + ' · ' + frame.time.toFixed(2) + ' s · ' + picture.width + ' × ' + picture.height + '. Review selected tasks.'
  render()
}
function point(event) {
  const box = editor.getBoundingClientRect()
  return { x: Math.max(0, Math.min(editor.width, (event.clientX - box.left) * editor.width / box.width)),
    y: Math.max(0, Math.min(editor.height, (event.clientY - box.top) * editor.height / box.height)) }
}
function paint(a, b) {
  const tool = $('tool').value, value = tool === 'erase' ? 0 : tool === 'object' ? 255 : Number($('value').value)
  for (const canvas of tool === 'erase' || tool === 'object' ? [alpha, objects] : [alpha]) {
    const c = canvas.getContext('2d'); c.strokeStyle = 'rgb(' + value + ',' + value + ',' + value + ')'
    c.lineCap = 'round'; c.lineJoin = 'round'; c.lineWidth = Number($('brush').value)
    c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x + .01, b.y + .01); c.stroke()
  }
  $('foreground-reviewed').checked = false
}
function pointerDown(event) {
  if (!frame || busy) return
  const p = point(event), faceTool = $('tool').value === 'face'
  if (faceTool && !tasks().faces || !faceTool && !tasks().foreground) return
  event.preventDefault(); editor.setPointerCapture(event.pointerId)
  if (faceTool) { drag = { start: p, end: p }; $('faces-reviewed').checked = false }
  else { lastPoint = p; paint(p, p) }
  render()
}
function pointerMove(event) {
  if (!frame || !editor.hasPointerCapture(event.pointerId)) return
  const p = point(event)
  if (drag) drag.end = p
  else if (lastPoint) { paint(lastPoint, p); lastPoint = p }
  render()
}
function pointerUp(event) {
  if (drag) {
    const x = Math.min(drag.start.x, drag.end.x), y = Math.min(drag.start.y, drag.end.y)
    const w = Math.abs(drag.start.x - drag.end.x), h = Math.abs(drag.start.y - drag.end.y)
    if (w >= 3 && h >= 3) {
      if (faces.length >= 32) throw new Error('Review no more than 32 faces per frame.')
      faces.push([x / editor.width, y / editor.height, w / editor.width, h / editor.height])
    }
  }
  drag = undefined; lastPoint = undefined
  if (editor.hasPointerCapture(event.pointerId)) editor.releasePointerCapture(event.pointerId)
  render()
}
async function importAlpha() {
  const selected = $('alpha-file').files[0]
  if (!selected || !frame) return
  const frameId = frame.id
  if (selected.type !== 'image/png' || selected.size > 16_000_000) throw new Error('Choose a bounded greyscale PNG mask.')
  const image = new Image(), url = URL.createObjectURL(selected)
  try {
    await loaded(image, url, 'load')
    if (frame?.id !== frameId) return
    const source = video.hidden ? still : video
    const originalW = source === video ? video.videoWidth : still.naturalWidth, originalH = source === video ? video.videoHeight : still.naturalHeight
    if (!(image.width === picture.width && image.height === picture.height) && !(image.width === originalW && image.height === originalH)) throw new Error('The mask must match the captured frame or original source dimensions.')
    alpha.getContext('2d').drawImage(image, 0, 0, alpha.width, alpha.height)
    $('foreground-reviewed').checked = false; render(); status('Mask imported as a draft. Review people, hands and held objects.')
  } finally { URL.revokeObjectURL(url); $('alpha-file').value = '' }
}
function saveFrame() {
  if (!frame) return
  const labels = tasks()
  if (labels.faces && !$('faces-reviewed').checked || labels.foreground && !$('foreground-reviewed').checked) throw new Error('Review each selected task before adding this frame.')
  if (editing === undefined && samples.length >= 24) throw new Error('Export this review before adding another batch of frames.')
  const sample = { ...frame, labels, rgb: picture.toDataURL('image/png'), faces: labels.faces ? structuredClone(faces) : [],
    faces_complete: labels.faces, foreground_reviewed: labels.foreground }
  if (labels.foreground) { sample.alpha = alpha.toDataURL('image/png'); sample.held_objects = objects.toDataURL('image/png') }
  if (editing === undefined) samples.push(sample)
  else samples[editing] = sample
  clearFrame(); renderSamples(); controls(); status('Reviewed frame saved in this tab. Save the project or export to keep it.')
}
function renderSamples() {
  $('samples').replaceChildren()
  for (const [index, sample] of samples.entries()) {
    const row = document.createElement('div'); row.className = 'sample'
    const text = document.createElement('p'), source = sources.find(source => source.id === sample.source)
    text.textContent = (index + 1) + '. ' + (source?.title ?? 'Unknown source') + ' · ' + source?.split + ' · ' + sample.time.toFixed(2) + ' s · ' + Object.entries(sample.labels).filter(([,value]) => value).map(([key]) => key).join(' + ')
    const edit = document.createElement('button'); edit.textContent = 'Edit frame'; edit.addEventListener('click', run(() => editFrame(index)))
    const remove = document.createElement('button'); remove.textContent = 'Remove frame'; remove.addEventListener('click', () => { samples.splice(index, 1); clearFrame(); renderSamples(); controls() })
    row.append(text, edit, remove); $('samples').append(row)
  }
}
async function editFrame(index) {
  const sample = samples[index], serial = ++annotationSerial; busy = true; controls()
  try {
    const image = new Image(); await loaded(image, sample.rgb, 'load')
    if (serial !== annotationSerial) return
    for (const canvas of [editor, picture, alpha, objects]) { canvas.width = image.width; canvas.height = image.height }
    picture.getContext('2d').drawImage(image, 0, 0); blankLabels()
    for (const [canvas, value] of [[alpha, sample.alpha], [objects, sample.held_objects]]) if (value) { const image = new Image(); await loaded(image, value, 'load'); if (serial !== annotationSerial) return; canvas.getContext('2d').drawImage(image, 0, 0) }
    frame = { id: sample.id, source: sample.source, time: sample.time }; editing = index; faces = structuredClone(sample.faces)
    $('tasks').value = sample.labels.faces ? sample.labels.foreground ? 'both' : 'faces' : 'foreground'
    $('frame-state').textContent = 'Editing reviewed frame ' + (index + 1) + '. Review its labels again before saving.'
    resetReviews(); render()
  } finally { if (serial === annotationSerial) { busy = false; controls() } }
}
function dataURL(value) {
  if (typeof value !== 'string' || !value.startsWith('data:image/png;base64,') || value.length > 16_000_000) return false
  try {
    const bytes = Uint8Array.from(atob(value.slice(22, 66)), c => c.charCodeAt(0)), view = new DataView(bytes.buffer)
    const width = view.getUint32(16), height = view.getUint32(20)
    return bytes[0] === 137 && bytes[1] === 80 && Math.min(width, height) >= 16 && Math.max(width, height) <= 2048 && width * height <= 2_000_000
  } catch { return false }
}
function validateProject(value) {
  if (![FORMAT, PROJECT].includes(value.format) || value.scope !== 'general' || !Array.isArray(value.sources) || !Array.isArray(value.samples) || value.sources.length > 64 || value.samples.length > 24) throw new Error('Choose a bounded Model Workshop review project.')
  const ids = new Set(), sampleIds = new Set()
  for (const source of value.sources) { if (typeof source.id !== 'string' || ids.has(source.id)) throw new Error('Invalid source identifiers.'); ids.add(source.id) }
  for (const sample of value.samples) {
    if (!ids.has(sample.source) || typeof sample.id !== 'string' || sampleIds.has(sample.id) || !dataURL(sample.rgb) || !Array.isArray(sample.faces) || sample.faces.length > 32 ||
      !sample.labels || typeof sample.labels.faces !== 'boolean' || typeof sample.labels.foreground !== 'boolean' || !(sample.labels.faces || sample.labels.foreground) ||
      !Number.isFinite(sample.time) || sample.time < 0 || sample.faces.some(box => !Array.isArray(box) || box.length !== 4 || box.some(n => !Number.isFinite(n))) ||
      sample.labels.foreground && (!dataURL(sample.alpha) || sample.held_objects && !dataURL(sample.held_objects))) throw new Error('Invalid saved frame. Only local PNG pictures and bounded labels are accepted.')
    sampleIds.add(sample.id)
  }
}
function exportable() {
  if (!samples.length) throw new Error('Add reviewed frames first.')
  const splits = new Set(), groups = new Map(), images = new Map()
  for (const sample of samples) {
    const source = sources.find(source => source.id === sample.source)
    if (!source || source.status !== 'approved' || !source.training || !source.commercial || !source.mit_weights || !source.subject_permission) throw new Error('Every exported frame needs an approved source review.')
    splits.add(source.split)
    for (const key of ['source:' + source.sha256, 'scene:' + source.scene, 'take:' + source.sequence, ...source.subjects.map(id => 'person:' + id)]) {
      if (groups.has(key) && groups.get(key) !== source.split) throw new Error('People, scenes, takes and source files must stay within one split. Review source groups.')
      groups.set(key, source.split)
    }
    if (images.has(sample.rgb) && images.get(sample.rgb) !== source.split) throw new Error('Identical pictures cannot cross splits.')
    images.set(sample.rgb, source.split)
  }
  if (!['train', 'validation', 'test'].every(split => splits.has(split))) throw new Error('Add independently grouped training, validation and held-out test sources before training export.')
}
function download(value, prefix) {
  const blob = new Blob([JSON.stringify(value)], { type: 'application/json' })
  if (blob.size > 192 * 1024 * 1024) throw new Error('Review export exceeds 192 MiB. Save fewer frames per batch.')
  const url = URL.createObjectURL(blob), link = document.createElement('a')
  link.href = url; link.download = prefix + '-' + Date.now() + '.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 30000)
}
function bundle(format) {
  const used = new Set(samples.map(sample => sample.source))
  return { format, scope: 'general', public_model_permission: format === FORMAT, created_at: new Date().toISOString(),
    sources: format === PROJECT ? sources : sources.filter(source => used.has(source.id)), samples }
}
on('footage', 'change', openFile); on('source-form', 'submit', approve)
on('source-notes', 'change', async () => {
  const selected = $('source-notes').files[0]; if (!selected) return
  if (!file || active || busy) throw new Error('Open an unapproved source file first.')
  if (selected.size > 128_000) throw new Error('Source notes are too large.')
  const notes = JSON.parse(await selected.text())
  if (notes.format !== 'kithmoot-workshop-source-notes-v1' || notes.source?.sha256 !== fileHash) throw new Error('Source notes do not match the opened file’s SHA-256.')
  for (const key of ['title', 'url', 'licence', 'terms', 'scene', 'sequence']) {
    if (typeof notes.source[key] === 'string') $(key).value = notes.source[key].slice(0, 24000)
  }
  for (const id of ['training-rights', 'commercial-rights', 'mit-rights', 'subject-rights']) $(id).checked = false
  $('source-notes').value = ''; status('Matching source notes loaded. Human rights review is still required; no source was approved.')
})
on('capture', 'click', capture); on('save-frame', 'click', saveFrame); on('alpha-file', 'change', importAlpha)
on('tasks', 'change', () => { resetReviews(); render(); controls() })
on('undo-face', 'click', () => { faces.pop(); $('faces-reviewed').checked = false; render() })
on('clear-labels', 'click', () => { faces = []; blankLabels(); resetReviews(); render() })
editor.addEventListener('pointerdown', run(pointerDown)); editor.addEventListener('pointermove', run(pointerMove)); editor.addEventListener('pointerup', run(pointerUp))
editor.addEventListener('pointercancel', () => { drag = undefined; lastPoint = undefined; render() })
on('save-project', 'click', () => download(bundle(PROJECT), 'kithmoot-workshop-review'))
on('export-training', 'click', () => { exportable(); download(bundle(FORMAT), 'kithmoot-workshop-training'); status('Reviewed data exported locally. The importer independently checks rights, labels, hashes and split leakage before training.') })
on('project-file', 'change', async () => {
  const selected = $('project-file').files[0]; if (!selected) return
  if (selected.size > 192 * 1024 * 1024) throw new Error('Review project is too large.')
  const value = JSON.parse(await selected.text()); validateProject(value)
  ++sourceSerial; releaseFile(); clearFrame(); sources = value.sources; samples = value.samples
  $('source-fields').disabled = false; $('source-form').reset(); renderSamples(); controls(); status('Saved review opened locally. Select Edit frame to inspect or correct labels.')
  $('project-file').value = ''
})
on('clear-project', 'click', () => { ++sourceSerial; releaseFile(); clearFrame(); sources = []; samples = []; busy = false
  $('source-fields').disabled = false; $('source-form').reset(); $('footage').value = ''; renderSamples(); controls(); status('Browser review cleared. Previously exported files remain on disk.') })
window.addEventListener('pagehide', () => { releaseFile() })
document.addEventListener('visibilitychange', () => { if (document.hidden) video.pause() })
try {
  const response = await fetch('sources.json'), candidates = (await response.json()).sources
  for (const source of candidates) {
    const card = document.createElement('article'); card.className = 'candidate'
    const title = document.createElement('h3'), state = document.createElement('p'), description = document.createElement('p'), link = document.createElement('a')
    title.textContent = source.title; state.textContent = source.status; description.textContent = source.summary
    link.href = safeURL(source.url); link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = 'Read original source'
    card.append(title, state, description, link)
    if (source.evidence_url) { const evidence = document.createElement('a'); evidence.href = safeURL(source.evidence_url); evidence.target = '_blank'; evidence.rel = 'noopener noreferrer'; evidence.textContent = ' · Licence evidence'; card.append(evidence) }
    $('candidates').append(card)
  }
} catch (error) { status('Source notes unavailable: ' + error.message) }
controls()
