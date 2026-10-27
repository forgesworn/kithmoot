import type { OpenedFile } from './attachment-card.js'

const CHUNK_BYTES = 1024 * 1024

export function nativeAttachmentSupport(): boolean {
  const bridge = window.kithmootDesktop
  return typeof bridge?.beginAttachment === 'function' && typeof bridge.writeAttachment === 'function'
    && typeof bridge.closeAttachment === 'function'
}

export class NativeAttachmentViewer {
  #url?: string
  #id?: string
  #generation = 0
  #reader?: ReadableStreamDefaultReader<Uint8Array>

  open(file: OpenedFile, trigger: HTMLElement): void {
    if (file.decision.preview !== 'image' && file.decision.preview !== 'audio' && file.decision.preview !== 'video') return
    this.close()
    const generation = this.#generation
    this.#url = file.url
    void this.#stream(file, file.decision.preview, trigger, generation)
  }

  async #stream(file: OpenedFile, kind: 'image' | 'audio' | 'video', trigger: HTMLElement, generation: number): Promise<void> {
    const bridge = window.kithmootDesktop
    if (!bridge?.beginAttachment || !bridge.writeAttachment || !bridge.closeAttachment) return
    let id: string | null | undefined
    try {
      id = await bridge.beginAttachment({ name: file.name, type: file.type, kind, size: file.blob.size })
      if (!id) throw new Error('The secure viewer could not be opened.')
      if (generation !== this.#generation) { await bridge.closeAttachment(id); return }
      this.#id = id
      const reader = file.blob.stream().getReader()
      this.#reader = reader
      for (;;) {
        const { done, value } = await reader.read()
        if (generation !== this.#generation) { await bridge.closeAttachment(id); return }
        if (done) {
          if (!await bridge.writeAttachment(id, new Uint8Array(), true)) throw new Error('The secure viewer could not receive the attachment.')
          break
        }
        for (let offset = 0; offset < value.byteLength; offset += CHUNK_BYTES) {
          const chunk = value.subarray(offset, Math.min(offset + CHUNK_BYTES, value.byteLength))
          if (!await bridge.writeAttachment(id, chunk, false)) throw new Error('The secure viewer could not receive the attachment.')
          if (generation !== this.#generation) { await bridge.closeAttachment(id); return }
        }
      }
      this.#reader = undefined
    } catch (error) {
      if (id) await bridge.closeAttachment(id)
      if (generation === this.#generation) {
        this.#id = undefined
        this.#url = undefined
        this.#reader = undefined
        trigger.textContent = error instanceof Error ? error.message : 'The secure viewer could not be opened.'
      }
    }
  }

  closeUrl(url: string): void { if (this.#url === url) this.close() }

  close(): void {
    this.#generation++
    const id = this.#id
    this.#id = undefined
    this.#url = undefined
    const reader = this.#reader
    this.#reader = undefined
    if (reader) void reader.cancel().catch(() => {})
    if (id) void window.kithmootDesktop?.closeAttachment?.(id)
  }
}
