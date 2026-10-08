/** One-shot recovery/cleanup sockets also participate in the activation
 * barrier. They cannot outlive the public pools merely because they use a
 * different reader. No room data is put in the wake-up message. */
export const PUBLIC_ROOM_OPERATIONS = 'f'.repeat(64)
type Guard = (stop: () => void) => Promise<() => Promise<void>>
let guard: Guard | undefined
export function guardPublicRoomOperations(next: Guard): void { guard = next }
export function publicRoomOperation(stop: () => void): Promise<() => Promise<void>> | undefined {
  return guard?.(stop)
}
