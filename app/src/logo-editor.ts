import { base64 } from '@scure/base'
import { logoFromCanvasEncoding, readLogoImage, type LogoImage } from '../../src/logo-image.js'

const MAX_INPUT_BYTES = 8 * 1024 * 1024
const MAX_INPUT_PIXELS = 16_777_216

/** Inspect the local file header before allocating decoded pixels. SVG and
 * animated inputs cannot make the editor fetch linked resources or frames. */
function inputSize(bytes: Uint8Array): [number, number] | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const word = (at: number, count: number) => String.fromCharCode(...bytes.subarray(at, at + count))
  if (bytes.length >= 24 && bytes.subarray(0, 8).every((b, i) => b === [137, 80, 78, 71, 13, 10, 26, 10][i])) {
    let at = 8
    while (at + 12 <= bytes.length) {
      const length = view.getUint32(at), type = word(at + 4, 4)
      if (at + 12 + length > bytes.length || type === 'acTL') return
      at += 12 + length
    }
    return [view.getUint32(16), view.getUint32(20)]
  }
  if (bytes.length >= 30 && word(0, 4) === 'RIFF' && word(8, 4) === 'WEBP') {
    const type = word(12, 4)
    if (type === 'VP8X' && !(bytes[20]! & 2)) {
      const u24 = (at: number) => bytes[at]! + bytes[at + 1]! * 256 + bytes[at + 2]! * 65536
      return [u24(24) + 1, u24(27) + 1]
    }
    if (type === 'VP8 ') return [view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff]
    if (type === 'VP8L' && bytes[20] === 0x2f) {
      const size = view.getUint32(21, true)
      return [(size & 0x3fff) + 1, ((size >>> 14) & 0x3fff) + 1]
    }
    return
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let at = 2
    while (at + 4 <= bytes.length) {
      if (bytes[at++] !== 0xff) return
      while (bytes[at] === 0xff) at++
      const marker = bytes[at++]
      if (marker === undefined || marker === 0xda || marker === 0xd9 || at + 2 > bytes.length) return
      const length = view.getUint16(at)
      if (length < 2 || at + length > bytes.length) return
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        return length >= 8 ? [view.getUint16(at + 5), view.getUint16(at + 3)] : undefined
      }
      at += length
    }
  }
}

/** The chosen crop always becomes new local pixels. Original file bytes,
 * metadata, filenames and URLs never enter shared room or project records. */
export function openLogoEditor(options: {
  name: string; image?: LogoImage | null; removeLabel?: string; canRemove?: boolean
  save(image: LogoImage | null): Promise<void>
}): HTMLDialogElement {
  const dialog = document.createElement('dialog')
  dialog.className = 'logoEditor'
  dialog.setAttribute('aria-labelledby', 'logoEditorTitle')
  // Only static controls use markup; names and errors are textContent.
  dialog.innerHTML = `<h2 id="logoEditorTitle"></h2>
    <p class="note">Choose a PNG, JPG or still WebP, up to 8 MB and 16 megapixels. Crop it here before sharing.</p>
    <label class="logoFile">Choose image<input type="file" accept="image/png,image/jpeg,image/webp" /></label>
    <figure><canvas width="256" height="256" role="img" aria-label="Logo crop preview"></canvas><figcaption>Preview</figcaption></figure>
    <label>Zoom<input type="range" min="1" max="4" step="0.05" value="1" /></label>
    <label>Horizontal position<input type="range" min="0" max="100" value="50" /></label>
    <label>Vertical position<input type="range" min="0" max="100" value="50" /></label>
    <p class="note logoEditorStatus" role="status" aria-live="polite"></p>
    <div class="logoEditorActions"><button type="button" data-action="remove"></button><button type="button" data-action="cancel">Cancel</button><button type="button" data-action="save" class="primary" disabled>Share logo</button></div>`
  dialog.querySelector('h2')!.textContent = `Logo for ${options.name}`
  const canvas = dialog.querySelector('canvas')!, file = dialog.querySelector('input[type=file]') as HTMLInputElement
  const ranges = [...dialog.querySelectorAll<HTMLInputElement>('input[type=range]')]
  const status = dialog.querySelector('.logoEditorStatus') as HTMLElement
  const save = dialog.querySelector('[data-action=save]') as HTMLButtonElement
  const remove = dialog.querySelector('[data-action=remove]') as HTMLButtonElement
  const cancel = dialog.querySelector('[data-action=cancel]') as HTMLButtonElement
  remove.textContent = options.removeLabel ?? 'Remove logo'
  remove.disabled = !options.image && !options.canRemove
  const restoreFocus = document.activeElement as HTMLElement | null
  let bitmap: ImageBitmap | undefined, generation = 0, closed = false, busy = false
  const setControls = () => {
    file.disabled = busy
    for (const range of ranges) range.disabled = busy || !bitmap
    save.disabled = busy || !bitmap
    remove.disabled = busy || !options.image && !options.canRemove
    cancel.disabled = busy
  }
  const draw = (target = canvas) => {
    const context = target.getContext('2d', { colorSpace: 'srgb' })!
    context.clearRect(0, 0, target.width, target.height)
    if (!bitmap) {
      context.fillStyle = getComputedStyle(dialog).color
      context.font = 'bold 96px system-ui'; context.textAlign = 'center'; context.textBaseline = 'middle'
      context.fillText([...options.name.trim()][0]?.toUpperCase() ?? '?', target.width / 2, target.height / 2)
      return
    }
    const size = Math.min(bitmap.width, bitmap.height) / Number(ranges[0]!.value)
    const x = (bitmap.width - size) * Number(ranges[1]!.value) / 100
    const y = (bitmap.height - size) * Number(ranges[2]!.value) / 100
    context.drawImage(bitmap, x, y, size, size, 0, 0, target.width, target.height)
  }
  for (const range of ranges) range.addEventListener('input', () => draw())
  const load = async (blob: Blob, inspect = true) => {
    const current = ++generation
    bitmap?.close(); bitmap = undefined; setControls(); draw()
    status.textContent = 'Opening image…'
    let opened: ImageBitmap | undefined
    try {
      if (!blob.size || blob.size > MAX_INPUT_BYTES) throw new Error('Choose an image up to 8 MB.')
      if (inspect) {
        const size = inputSize(new Uint8Array(await blob.arrayBuffer()))
        if (!size) throw new Error('Choose a valid PNG, JPG or still WebP image.')
        if (!size.every(n => n > 0 && n <= 8192) || size[0] * size[1] > MAX_INPUT_PIXELS) throw new Error('Choose an image up to 16 megapixels and 8,192 pixels per side.')
      }
      opened = await createImageBitmap(blob)
      if (closed || current !== generation) { opened.close(); return }
      if (opened.width * opened.height > MAX_INPUT_PIXELS || opened.width > 8192 || opened.height > 8192) throw new Error('Choose an image up to 16 megapixels.')
      bitmap = opened; opened = undefined
      ranges[0]!.value = '1'; ranges[1]!.value = ranges[2]!.value = '50'
      draw(); status.textContent = 'Adjust the crop, then share it with everyone in this room or project.'
    } catch (error) {
      opened?.close()
      if (closed || current !== generation) return
      status.textContent = error instanceof Error ? error.message : 'This image could not be opened.'
    } finally { if (!closed && current === generation) setControls() }
  }
  file.addEventListener('change', () => { if (file.files?.[0]) void load(file.files[0]) })
  const encodeCrop = async (): Promise<LogoImage> => {
    for (const pixels of [256, 192, 128, 96]) for (const quality of [0.88, 0.7]) {
      const output = document.createElement('canvas'); output.width = output.height = pixels; draw(output)
      const blob = await new Promise<Blob | null>(resolve => output.toBlob(resolve, 'image/webp', quality))
      if (!blob) continue
      try { return logoFromCanvasEncoding(new Uint8Array(await blob.arrayBuffer()), blob.type === 'image/png' ? 'image/png' : 'image/webp') } catch { /* Try a smaller fresh encoding. */ }
    }
    throw new Error('This crop could not fit the logo limit. Choose a simpler image.')
  }
  const apply = async (clear: boolean) => {
    if (closed || busy || !clear && !bitmap) return
    busy = true; setControls(); status.textContent = clear ? 'Removing logo…' : 'Sharing logo…'
    try {
      const image = clear ? null : await encodeCrop()
      if (closed) return
      await options.save(image)
      dialog.close()
    } catch (error) {
      if (!closed) status.textContent = error instanceof Error ? error.message : 'The logo could not be shared. Try again.'
    } finally { busy = false; if (!closed) setControls() }
  }
  save.addEventListener('click', () => { void apply(false) })
  remove.addEventListener('click', () => { void apply(true) })
  cancel.addEventListener('click', () => { if (!busy) dialog.close() })
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault() })
  dialog.addEventListener('close', () => {
    closed = true; ++generation; bitmap?.close(); bitmap = undefined; dialog.remove()
    if (restoreFocus?.isConnected) restoreFocus.focus({ preventScroll: true })
  }, { once: true })
  document.body.append(dialog); dialog.showModal(); setControls(); draw()
  const existing = readLogoImage(options.image)
  if (existing) void load(new Blob([new Uint8Array(base64.decode(existing.data))], { type: existing.mime }), false)
  return dialog
}
