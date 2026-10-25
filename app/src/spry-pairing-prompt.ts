import { parseSpryPairingLink } from '../../src/spry.js'
import { confirmAction } from './confirm-action.js'
import { appPlatform, ANDROID_DOWNLOAD_URL, DESKTOP_DOWNLOAD_URL } from './open-in-app.js'
import { renderQr } from './qr.js'

/** Keep the one-use code in the fragment, without involving a redirect server. */
export function spryAppLink(hash: string): string {
  parseSpryPairingLink(hash)
  return `kithmoot://join${hash}`
}

export function confirmSpryPairingTarget(hash: string, host: string,
  options: { desktop: boolean; syncAccount?: boolean; isCurrent: () => boolean }): Promise<boolean> {
  if (options.desktop) return confirmAction({
    title: 'Pair Spry with KithMoot?',
    message: `${host} will help connect your calls and give the people in them temporary relay access automatically. Your room and media keys stay in KithMoot. ${options.syncAccount ? 'The pairing is encrypted to your Nostr account and shared with your other signed-in devices.' : 'This pairing stays on this device.'}`,
    confirmLabel: 'Pair Spry', isCurrent: options.isCurrent,
  })

  const content = document.createElement('div')
  content.className = 'spryPairingTargets'
  const message = document.createElement('p')
  message.className = 'note'
  message.setAttribute('role', 'status')
  const platform = appPlatform(navigator.userAgent, navigator.maxTouchPoints)
  if (platform) {
    const open = document.createElement('button')
    open.type = 'button'
    open.className = 'primary'
    open.textContent = 'Open KithMoot app'
    open.onclick = () => {
      if (!options.isCurrent()) return
      try {
        location.assign(spryAppLink(hash))
        message.textContent = 'Finish pairing in KithMoot. If it did not open, update the app and try again.'
      } catch { message.textContent = 'This pairing link has expired. Open Spry and start a fresh pairing.' }
    }
    const download = document.createElement('a')
    download.href = platform === 'desktop' ? DESKTOP_DOWNLOAD_URL : ANDROID_DOWNLOAD_URL
    download.textContent = 'Get the latest KithMoot app'
    content.append(open, download)
  }
  const phone = document.createElement('button')
  phone.type = 'button'
  phone.textContent = 'Pair Android phone'
  const instructions = document.createElement('p')
  instructions.className = 'note'
  instructions.textContent = 'Scan this code on your Android phone and open it in KithMoot, then choose Pair Spry. Signed in with the same Nostr account? Pair once and it follows your devices. For a device without that account, use a fresh one-use link.'
  const canvas = document.createElement('canvas')
  canvas.setAttribute('aria-label', 'Spry pairing QR code for Android')
  canvas.style.cssText = 'max-width:100%;height:auto;background:white'
  const linkLabel = document.createElement('label')
  linkLabel.textContent = 'Pairing link for the KithMoot app'
  const link = document.createElement('input')
  link.type = 'text'
  link.readOnly = true
  link.autocomplete = 'off'
  link.spellcheck = false
  link.setAttribute('aria-label', 'Pairing link for the KithMoot app')
  link.value = spryAppLink(hash)
  link.onclick = () => link.select()
  linkLabel.append(link)
  const copy = document.createElement('button')
  copy.type = 'button'
  copy.textContent = 'Copy pairing link'
  copy.onclick = async () => {
    if (!options.isCurrent()) return
    let current: string
    try { current = spryAppLink(hash) }
    catch { link.value = ''; copy.disabled = true; message.textContent = 'This pairing link has expired. Open Spry and start a fresh pairing.'; return }
    try { await navigator.clipboard.writeText(current); message.textContent = 'Pairing link copied. Open it in the KithMoot app, where you are already signed in.' }
    catch { link.focus(); link.select(); message.textContent = 'The pairing link is selected. Choose Copy, or press Command-C on Mac or Ctrl-C on Windows/Linux.' }
  }
  const qr = document.createElement('div')
  qr.hidden = true
  qr.append(instructions, canvas)
  phone.onclick = async () => {
    if (!options.isCurrent()) return
    try { await renderQr(canvas, spryAppLink(hash)); qr.hidden = false }
    catch { message.textContent = 'The QR code could not be made. Open Spry and start a fresh pairing.' }
  }
  content.append(linkLabel, copy, phone, qr, message)
  return confirmAction({
    title: 'Where do you want to pair Spry?',
    message: `${host} will help connect your calls. ${options.syncAccount ? 'Pairing here shares the pairing, encrypted, with your other devices signed into this Nostr account.' : 'Open the KithMoot app or pair this browser. Sign in with Nostr before pairing to share it with your other devices.'}`,
    confirmLabel: options.syncAccount ? 'Pair this Nostr account' : 'Pair this browser', content, isCurrent: options.isCurrent,
  })
}
