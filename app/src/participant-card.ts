import { logoDataUrl, type LogoImage } from '../../src/logo-image.js'
import { openLogoEditor } from './logo-editor.js'

export interface ParticipantDetails {
  name?: string; npub: string; pubkey: string; picture?: string; nip05?: string; nostr: boolean
}

interface LocalPhotoControl {
  image?: LogoImage
  save(image: LogoImage | null): void
}

/** Uses the profile already allowed by the room's lookup setting. Opening adds no lookup. */
export class ParticipantCard {
  #dialog?: HTMLDialogElement
  constructor(private readonly copy: (text: string) => Promise<boolean>) {}
  close(): void { this.#dialog?.close() }
  open(person: ParticipantDetails, anchor: HTMLElement, message?: () => void, photo?: LocalPhotoControl): void {
    this.close()
    const dialog = document.createElement('dialog'); this.#dialog = dialog
    dialog.className = 'participantCard'; dialog.setAttribute('aria-label', 'Participant details')
    const title = document.createElement('h2'); title.textContent = person.name ?? 'Participant'
    dialog.append(title)
    let avatar: HTMLImageElement | undefined
    const showPicture = (source?: string): void => {
      avatar?.remove()
      if (!source) return
      const image = document.createElement('img')
      image.src = source; image.alt = ''; image.className = 'avatar'; image.referrerPolicy = 'no-referrer'
      image.addEventListener('error', () => image.remove(), { once: true })
      title.after(image); avatar = image
    }
    showPicture(person.picture)
    const kind = document.createElement('p'); kind.textContent = person.nostr ? 'Nostr profile · names and pictures are self-reported.' : 'Room participant'
    dialog.append(kind)
    const field = (label: string, value: string): void => {
      const row = document.createElement('div'); const text = document.createElement('p'); text.textContent = value
      const button = document.createElement('button'); button.type = 'button'; button.textContent = `Copy ${label}`
      button.onclick = async () => { button.textContent = await this.copy(value) ? `Copied ${label}` : 'Copy failed' }
      row.append(text, button); dialog.append(row)
    }
    field('npub', person.npub)
    if (person.nip05) {
      const verified = document.createElement('p'); verified.textContent = 'NIP-05: the address domain maps this public key.'; dialog.append(verified)
      field('NIP-05', person.nip05)
    }
    if (message) {
      const dm = document.createElement('button'); dm.type = 'button'; dm.textContent = 'Message privately'
      dm.onclick = () => { dialog.close(); message() }; dialog.append(dm)
    }
    let editor: HTMLDialogElement | undefined
    if (photo) {
      const change = document.createElement('button')
      change.type = 'button'; change.textContent = 'Set photo on this device'
      change.setAttribute('aria-haspopup', 'dialog')
      let current = photo.image
      change.onclick = () => {
        editor = openLogoEditor({ name: person.name ?? 'participant', image: current, localPhoto: true,
          save: async image => {
            photo.save(image)
            current = image ?? undefined
            showPicture(logoDataUrl(current))
          } })
      }
      dialog.append(change)
    }
    const close = document.createElement('button'); close.type = 'button'; close.textContent = 'Close participant details'; close.onclick = () => dialog.close()
    dialog.append(close)
    dialog.addEventListener('close', () => {
      editor?.close()
      dialog.remove(); if (this.#dialog === dialog) this.#dialog = undefined
      if (anchor.isConnected) anchor.focus({ preventScroll: true })
    })
    document.body.append(dialog); dialog.showModal()
  }
}
