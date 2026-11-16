import { sanitiseDisplayName } from '../../src/display-name.js'

/** A shared room name is not an identity assertion. Older clients sometimes
 * remembered our own name here; prefer names belonging to the other person. */
export function directChatName(options: {
  chatLabel?: string
  peerName?: string
  rosterName?: string
  rememberedName?: string
  selfName?: string
}): string {
  const remembered = sanitiseDisplayName(options.rememberedName)
  return sanitiseDisplayName(options.chatLabel)
    ?? sanitiseDisplayName(options.peerName)
    ?? sanitiseDisplayName(options.rosterName)
    ?? (remembered !== sanitiseDisplayName(options.selfName) ? remembered : undefined)
    ?? 'Private chat'
}
