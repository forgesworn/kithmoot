const parameters = new URLSearchParams(location.hash.slice(1))
const id = parameters.get('id') ?? ''
const kind = parameters.get('kind') ?? ''
const name = parameters.get('name') ?? 'Attachment'
const status = document.getElementById('attachment-status')
const surface = document.getElementById('attachment-surface')

if (/^[a-f0-9]{64}$/.test(id) && ['image', 'audio', 'video'].includes(kind)) {
  const heading = document.getElementById('attachment-name')
  heading.textContent = name
  document.title = name
  const media = document.createElement(kind === 'image' ? 'img' : kind)
  media.setAttribute('aria-label', name)
  if (kind === 'image') media.alt = name
  else {
    media.controls = true
    media.preload = 'auto'
    if (kind === 'video') media.playsInline = true
  }
  const opened = () => { status.textContent = '' }
  const failed = () => { status.textContent = 'This attachment could not be opened.' }
  media.addEventListener(kind === 'image' ? 'load' : 'loadedmetadata', opened)
  media.addEventListener('error', failed)
  surface.append(media)
  media.src = `kithmoot-attachment://media/${id}`
  window.addEventListener('pagehide', () => {
    media.removeAttribute('src')
    if (kind !== 'image') media.load()
  }, { once: true })
} else {
  status.textContent = 'This attachment cannot be previewed. PDF and other documents remain save-only.'
}
