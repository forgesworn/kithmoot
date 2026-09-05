import type { ChatAttachment } from '../../src/chat.js'

export interface ConversationDraft {
  readonly channel: string | undefined
  text: string
  selectionStart: number
  selectionEnd: number
  selectionDirection: 'forward' | 'backward' | 'none'
  attachments: ChatAttachment[]
  event: string
  key: string
  panelOpen: boolean
  status: string
  job?: AbortController
}

export function draftHasWork(draft: ConversationDraft): boolean {
  return Boolean(draft.text || draft.event || draft.key || draft.attachments.length || draft.job)
}

/** Drafts belong to one conversation in this room visit. They never enter
 * storage or relays. Async file work retains the originating draft object. */
export class ConversationDrafts {
  readonly #drafts = new Map<string | undefined, ConversationDraft>()

  get(channel: string | undefined): ConversationDraft {
    let draft = this.#drafts.get(channel)
    if (!draft) {
      draft = { channel, text: '', selectionStart: 0, selectionEnd: 0, selectionDirection: 'none',
        attachments: [], event: '', key: '', panelOpen: false, status: '' }
      this.#drafts.set(channel, draft)
    }
    return draft
  }

  pending(): ConversationDraft[] {
    return [...this.#drafts.values()].filter(draftHasWork)
  }

  discard(draft: ConversationDraft): void {
    draft.job?.abort()
    draft.job = undefined
    draft.text = draft.event = draft.key = draft.status = ''
    draft.selectionStart = draft.selectionEnd = 0
    draft.selectionDirection = 'none'
    draft.attachments = []
    draft.panelOpen = false
  }

  close(): void {
    for (const draft of this.#drafts.values()) this.discard(draft)
    this.#drafts.clear()
  }
}
