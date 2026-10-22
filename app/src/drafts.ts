import type { ChatAttachment, ChatMessage } from '../../src/chat.js'
import type { ChatArtwork } from '../../src/artwork.js'

/** One line in the staged-files tray after an upload did not go through. */
export interface FileTrayFailure {
  text: string
  /** Offer Try again. */
  retry?: boolean
  /** Offer Choose another server. */
  another?: boolean
  /** The file it is about: removing that file clears the line. */
  file?: File
}

export interface ConversationDraft {
  readonly channel: string | undefined
  text: string
  selectionStart: number
  selectionEnd: number
  selectionDirection: 'forward' | 'backward' | 'none'
  attachments: ChatAttachment[]
  artwork: ChatArtwork[]
  /** Files picked but not yet uploaded: held (S0, off, no storage) or being
   *  uploaded right now. A file leaves this list when it becomes an attachment. */
  pendingFiles?: File[]
  /** Files the destination or the app will not take, with the reason shown in
   *  the tray. They stay as chips until removed, and are never uploaded. */
  refusedFiles?: Map<File, string>
  /** The file being sealed and uploaded now, so its chip can stop it. */
  uploading?: File
  /** What went wrong with the last upload, in the tray's words. */
  fileError?: FileTrayFailure
  event: string
  key: string
  panelOpen: boolean
  status: string
  job?: AbortController
  replyTo?: ChatMessage
  editing?: ChatMessage
  /** Lowercased displayed name -> participant, for every name the `@`
   *  picker has inserted into this draft since it was last discarded. Lets
   *  a name shared by more than one participant still resolve to whoever
   *  was actually picked when the draft is sent - see
   *  `mention-candidates.ts`. */
  pickedMentions?: Map<string, string>
}

/** Include recipient bindings even when two people have the same shown name. */
export function draftSubmissionSnapshot(text: string, draft: ConversationDraft): string {
  const mentions = [...(draft.pickedMentions ?? [])].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
  return JSON.stringify([text, draft.attachments, draft.artwork, draft.editing, draft.replyTo, mentions])
}

export function draftHasWork(draft: ConversationDraft): boolean {
  return Boolean(draft.text || draft.event || draft.key || draft.attachments.length || draft.artwork.length || draft.pendingFiles?.length || draft.job)
}

/** Drafts belong to one conversation in this room visit. They never enter
 * storage or relays. Async file work retains the originating draft object. */
export class ConversationDrafts {
  readonly #drafts = new Map<string | undefined, ConversationDraft>()

  get(channel: string | undefined): ConversationDraft {
    let draft = this.#drafts.get(channel)
    if (!draft) {
      draft = { channel, text: '', selectionStart: 0, selectionEnd: 0, selectionDirection: 'none',
        attachments: [], artwork: [], event: '', key: '', panelOpen: false, status: '' }
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
    draft.artwork = []
    draft.pendingFiles = []
    draft.refusedFiles = undefined
    draft.uploading = undefined
    draft.fileError = undefined
    draft.panelOpen = false
    draft.replyTo = draft.editing = undefined
    draft.pickedMentions = undefined
  }

  close(): void {
    for (const draft of this.#drafts.values()) this.discard(draft)
    this.#drafts.clear()
  }
}
