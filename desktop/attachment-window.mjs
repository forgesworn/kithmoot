import { BrowserWindow, session } from 'electron'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { appContentPolicy, ORIGIN } from './policy.mjs'
import {
  AttachmentStream, MAX_ATTACHMENT_STREAMS, MAX_OWNER_ATTACHMENT_BYTES,
  parseAttachmentRange, validateAttachmentMetadata,
} from './attachment-stream.mjs'

export const ATTACHMENT_SCHEME = 'kithmoot-attachment'
export const ATTACHMENT_FRAME_URL = `${ORIGIN}/j/attachment-frame.html`
const here = fileURLToPath(new URL('.', import.meta.url))
const viewerFiles = new Map([
  ['/j/attachment-frame.html', ['attachment-frame.html', 'text/html']],
  ['/j/attachment-frame.css', ['attachment-frame.css', 'text/css']],
  ['/j/attachment-frame.js', ['attachment-frame.js', 'text/javascript']],
])
const denied = () => new Response('Denied', { status: 403 })

export function registerAttachmentScheme(protocol) {
  protocol.registerSchemesAsPrivileged([{
    scheme: ATTACHMENT_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: false, stream: true },
  }])
}

export function attachmentViewerAsset(value) {
  let url
  try { url = new URL(value) } catch { return null }
  if (!viewerFiles.has(url.pathname)) return undefined
  if (url.origin !== ORIGIN || url.username || url.password || url.search) return null
  const [name, type] = viewerFiles.get(url.pathname)
  return { path: join(here, name), type }
}

function viewerBody(parts, stream) {
  let index = 0
  return new ReadableStream({
    pull(controller) {
      if (!stream.active) { controller.error(new Error('Attachment closed')); return }
      if (index === parts.length) { controller.close(); return }
      controller.enqueue(parts[index++])
    },
  })
}

export class AttachmentWindows {
  #streams = new Map()
  #owners = new WeakMap()
  #contents = new Set()
  #creating = false
  #icon

  constructor({ icon } = {}) {
    this.#icon = icon
  }

  manages(contents) {
    return this.#creating || this.#contents.has(contents)
  }

  begin(owner, metadata) {
    const validated = validateAttachmentMetadata(metadata)
    if (!validated) return null
    const existing = this.#owners.get(owner)
    if (existing?.streams.size >= MAX_ATTACHMENT_STREAMS) return null
    let declared = validated.size
    for (const stream of existing?.streams ?? []) declared += stream.metadata.size
    if (declared > MAX_OWNER_ATTACHMENT_BYTES) return null
    const owned = existing ?? this.#owner(owner)
    const id = randomBytes(32).toString('hex')
    const stream = new AttachmentStream(id, validated)
    stream.owner = owner
    this.#streams.set(id, stream)
    owned.streams.add(stream)
    try { this.#open(stream) } catch {
      this.#invalidate(stream)
      return null
    }
    return id
  }

  write(owner, id, chunk, finish) {
    const stream = this.#streams.get(id)
    if (!stream || stream.owner !== owner) return false
    const accepted = stream.write(chunk, finish)
    if (!accepted && !stream.active) this.#invalidate(stream)
    return accepted
  }

  close(owner, id) {
    const stream = this.#streams.get(id)
    if (!stream || stream.owner !== owner) return false
    this.#invalidate(stream)
    return true
  }

  closeOwner(owner) {
    const owned = this.#owners.get(owner)
    if (!owned) return 0
    const streams = [...owned.streams]
    for (const stream of streams) this.#invalidate(stream)
    return streams.length
  }

  closeAll() {
    for (const stream of [...this.#streams.values()]) this.#invalidate(stream)
  }

  #owner(contents) {
    let owned = this.#owners.get(contents)
    if (owned) return owned
    const streams = new Set()
    const destroyed = () => this.closeOwner(contents)
    const gone = () => this.closeOwner(contents)
    const navigating = (_event, _url, _isInPlace, isMainFrame) => { if (isMainFrame) this.closeOwner(contents) }
    owned = { streams, destroyed, gone, navigating }
    this.#owners.set(contents, owned)
    contents.once('destroyed', destroyed)
    contents.on('render-process-gone', gone)
    contents.on('did-start-navigation', navigating)
    return owned
  }

  #releaseOwner(stream) {
    const owned = this.#owners.get(stream.owner)
    if (!owned) return
    owned.streams.delete(stream)
    if (owned.streams.size) return
    stream.owner.removeListener('destroyed', owned.destroyed)
    stream.owner.removeListener('render-process-gone', owned.gone)
    stream.owner.removeListener('did-start-navigation', owned.navigating)
    this.#owners.delete(stream.owner)
  }

  #open(stream) {
    const ses = session.fromPartition(`kithmoot-attachment-${stream.id}`, { cache: false })
    stream.session = ses
    ses.protocol.handle('https', async request => {
      const asset = attachmentViewerAsset(request.url)
      if (!asset || !['GET', 'HEAD'].includes(request.method)) return new Response('Not found', { status: 404 })
      try {
        const body = await readFile(asset.path)
        return new Response(request.method === 'HEAD' ? null : body, { headers: {
          'Content-Type': asset.type,
          'Content-Security-Policy': appContentPolicy(request.url),
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'no-store',
        } })
      } catch { return new Response('Not found', { status: 404 }) }
    })
    ses.protocol.handle('http', denied)
    ses.protocol.handle(ATTACHMENT_SCHEME, request => this.#media(request, stream))
    ses.webRequest.onBeforeRequest((details, callback) => {
      const asset = attachmentViewerAsset(details.url)
      const media = this.#mediaUrl(details.url, stream)
      callback({ cancel: !asset && !media })
    })
    ses.setPermissionCheckHandler(() => false)
    ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    ses.on('will-download', event => event.preventDefault())

    this.#creating = true
    let window
    try {
      window = new BrowserWindow({
        title: stream.metadata.name, width: 1000, height: 750, minWidth: 420, minHeight: 300,
        show: false, autoHideMenuBar: true, backgroundColor: '#0f1215',
        ...(this.#icon ? { icon: this.#icon } : {}),
        webPreferences: {
          session: ses, nodeIntegration: false, contextIsolation: true, sandbox: true,
          webSecurity: true, plugins: false, webviewTag: false, spellcheck: false,
          allowRunningInsecureContent: false, backgroundThrottling: false,
        },
      })
    } finally { this.#creating = false }
    stream.window = window
    this.#contents.add(window.webContents)
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', event => event.preventDefault())
    window.webContents.on('will-frame-navigate', event => { if (event.isMainFrame) event.preventDefault() })
    window.webContents.on('will-redirect', event => event.preventDefault())
    window.webContents.on('will-attach-webview', event => event.preventDefault())
    window.webContents.on('render-process-gone', () => this.#invalidate(stream))
    window.once('closed', () => this.#invalidate(stream, false))
    window.once('ready-to-show', () => { if (!window.isDestroyed()) window.show() })
    const parameters = new URLSearchParams({ id: stream.id, kind: stream.metadata.kind, name: stream.metadata.name })
    void window.loadURL(`${ATTACHMENT_FRAME_URL}#${parameters}`).catch(() => this.#invalidate(stream))
  }

  #mediaUrl(value, stream) {
    let url
    try { url = new URL(value) } catch { return false }
    return url.protocol === `${ATTACHMENT_SCHEME}:` && url.host === 'media' && url.pathname === `/${stream.id}` && !url.username && !url.password && !url.search && !url.hash
  }

  async #media(request, stream) {
    if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405 })
    if (!this.#mediaUrl(request.url, stream) || !stream.active) return new Response('Gone', { status: 410 })
    if (!await stream.ready() || !stream.active) return new Response('Gone', { status: 410 })
    const range = parseAttachmentRange(request.headers.get('range') ?? undefined, stream.metadata.size)
    if (!range) return new Response('Range not satisfiable', { status: 416, headers: {
      'Content-Range': `bytes */${stream.metadata.size}`,
      'Cache-Control': 'no-store',
    } })
    const parts = stream.range(range.start, range.end)
    if (!parts) return new Response('Gone', { status: 410 })
    const ranged = request.headers.has('range')
    const headers = {
      'Content-Type': stream.metadata.type,
      'Content-Length': String(range.end - range.start + 1),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    }
    if (ranged) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${stream.metadata.size}`
    return new Response(request.method === 'HEAD' ? null : viewerBody(parts, stream), { status: ranged ? 206 : 200, headers })
  }

  #invalidate(stream, closeWindow = true) {
    stream.invalidate()
    this.#streams.delete(stream.id)
    this.#releaseOwner(stream)
    if (stream.window) {
      this.#contents.delete(stream.window.webContents)
      if (closeWindow && !stream.window.isDestroyed()) stream.window.destroy()
    }
    if (stream.session) {
      for (const scheme of ['https', 'http', ATTACHMENT_SCHEME]) void stream.session.protocol.unhandle(scheme).catch(() => {})
    }
  }
}
