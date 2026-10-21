import type { PrivateFileOwner, BrowserBothyFiles } from './browser-bothy-files.js'
import type { PrivateFileVault } from './private-file-vault.js'

/** Owner cleanup is available from Account even when the originating room
 * expired or was forgotten. It uses durable receipts and existing pairing;
 * opening this panel never connects, signs or sends a network request. */
export class PrivateFileUploadsPanel {
  #dialog = document.createElement('dialog')
  #list = document.createElement('div')
  #operation?: AbortController
  #generation = 0
  constructor(private vault: PrivateFileVault, private files: BrowserBothyFiles, private owner: () => PrivateFileOwner | undefined) {
    this.#dialog.id = 'privateFileUploads'
    const title = document.createElement('h2'), note = document.createElement('p'), close = document.createElement('button')
    title.textContent = 'Private uploads kept on this browser'
    title.id = 'privateFileUploadsTitle'; this.#dialog.setAttribute('aria-labelledby', title.id)
    note.textContent = 'These encrypted upload records belong to your signed-in account, including closed or forgotten rooms. Connect the recorded Bothy first. Delete asks that exact box to remove your upload; other owners or recipients can retain copies. Unconfirmed uploads may already be stored. Records stay until the box confirms your claim was removed or reports the file absent.'
    close.type = 'button'; close.textContent = 'Close'; close.onclick = () => this.close()
    this.#dialog.append(title, note, this.#list, close); document.body.append(this.#dialog)
    this.#dialog.addEventListener('cancel', () => this.close())
    window.addEventListener('pagehide', () => this.close())
  }
  close(): void {
    this.#generation++; this.#operation?.abort(new Error('Upload review closed.'))
    this.#operation = undefined; this.#dialog.close(); this.#list.replaceChildren()
  }
  async open(): Promise<void> {
    this.close(); this.#dialog.showModal()
    const generation = this.#generation, owner = this.owner()
    const current = (): boolean => {
      const actual = this.owner()
      return generation === this.#generation && this.#dialog.open && !!owner && actual?.identity === owner.identity && actual?.generation === owner.generation
    }
    if (!owner) { this.#list.textContent = 'Sign in as the uploading account to review its private uploads.'; return }
    this.#list.textContent = 'Opening encrypted upload records…'
    try {
      const rows = await this.vault.accountUploads(owner.identity.pubkey)
      if (!current()) return
      this.#list.replaceChildren()
      if (!rows.length) this.#list.textContent = 'No private uploads are recorded for this account.'
      for (const receipt of rows) {
        const row = document.createElement('p'), label = document.createElement('span'), remove = document.createElement('button')
        label.textContent = `${receipt.hash} · ${receipt.size.toLocaleString()} encrypted bytes · ${receipt.status} · room ${receipt.room} · Bothy ${receipt.node}. `
        row.style.overflowWrap = 'anywhere'; remove.type = 'button'; remove.textContent = 'Delete this upload'
        remove.onclick = async () => {
          if (!current() || this.#operation) return
          const operation = new AbortController(); this.#operation = operation; remove.disabled = true
          try {
            const result = await this.files.remove(receipt, operation.signal)
            if (!current()) return
            label.textContent = result === 'deleted' ? 'The box confirmed deletion of your upload.'
              : result === 'claim-removed' ? 'Your storage claim was removed. Other owners retain the encrypted file.'
              : 'The recorded box reports this file absent. This does not establish erasure of other copies.'
            remove.textContent = 'Resolved'
          } catch (error) {
            if (current()) label.textContent = `${error instanceof Error ? error.message : 'Deletion failed.'} The upload record stays. Close and reopen this review to retry.`
          } finally { if (this.#operation === operation) this.#operation = undefined }
        }
        row.append(label, remove); this.#list.append(row)
      }
    } catch (error) {
      if (current()) this.#list.textContent = `Upload records could not be opened; nothing was discarded. ${error instanceof Error ? error.message : ''}`
    }
  }
}
