(() => {
  'use strict'

  let objectUrl
  let port

  function previewElement(kind, url) {
    if (kind === 'image') {
      const image = document.createElement('img')
      image.src = url
      image.alt = ''
      image.draggable = false
      return image
    }
    if (kind === 'audio' || kind === 'video') {
      const media = document.createElement(kind)
      media.controls = true
      media.preload = 'metadata'
      media.src = url
      media.setAttribute('aria-label', `${kind === 'audio' ? 'Audio' : 'Video'} preview`)
      if (kind === 'video') media.playsInline = true
      return media
    }
    const object = document.createElement('object')
    object.type = 'application/pdf'
    object.data = url
    object.setAttribute('aria-label', 'PDF preview')
    object.textContent = 'PDF preview is not available in this browser.'
    return object
  }

  function accepts(kind, blob) {
    const mime = blob.type.split(';')[0].trim().toLowerCase()
    return kind === 'pdf' ? mime === 'application/pdf' : mime.startsWith(`${kind}/`)
  }

  function release() {
    if (objectUrl) URL.revokeObjectURL(objectUrl)
    objectUrl = undefined
  }

  window.addEventListener('message', event => {
    if (port || event.source !== window.parent || event.ports.length !== 1) return
    const message = event.data
    if (message?.type !== 'kithmoot:attachment-preview:init' || !(message.blob instanceof Blob)) return
    const kind = message.kind
    if (kind !== 'image' && kind !== 'audio' && kind !== 'video' && kind !== 'pdf') return
    if (!accepts(kind, message.blob)) return

    port = event.ports[0]
    port.addEventListener('message', command => {
      const data = command.data
      if (data?.type === 'kithmoot:attachment-preview:dispose') {
        release()
        port?.close()
        port = undefined
        return
      }
      if (data?.type === 'kithmoot:attachment-preview:actual-size' && typeof data.actual === 'boolean') {
        document.body.classList.toggle('actualSize', data.actual)
      }
    })
    port.start()

    release()
    objectUrl = URL.createObjectURL(message.blob)
    port.postMessage({ type: 'kithmoot:attachment-preview:url', url: objectUrl })
    document.body.replaceChildren(previewElement(kind, objectUrl))
  })

  window.addEventListener('pagehide', () => {
    release()
    port?.close()
    port = undefined
  }, { once: true })
})()
