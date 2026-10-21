/** The existing Link Blossom fsl:// reference, restricted to its canonical
 * extension-free form for chat. It is a location, never authority to discover,
 * dial or fetch a node. An app must bind it to its selected paired route. */
export interface PrivateAttachmentLocation { node: string; hash: string }
const reference = /^fsl:\/\/([a-z2-7]{51}[aq])\/([0-9a-f]{64})$/
export function privateAttachmentLocation(value: string, expectedHash?: string): PrivateAttachmentLocation | undefined {
  if (typeof value !== 'string') return undefined
  const match = reference.exec(value)
  if (!match || (expectedHash !== undefined && match[2] !== expectedHash.toLowerCase())) return undefined
  return { node: match[1]!, hash: match[2]! }
}
export function privateAttachmentUrl(node: string, hash: string): string {
  const value = `fsl://${node}/${hash}`
  if (!privateAttachmentLocation(value)) throw new Error('Invalid private file reference.')
  return value
}
