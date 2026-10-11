import { decodeControl, type ControlMessage } from '../../src/control.js'
import { verifyRecordingNotice } from '../../src/meeting.js'
import type { DeviceStore } from './device-store.js'

export type SignedRecordingOff = Extract<ControlMessage, { op: 'recording' }> & { on: false }

/** One exact authority-signed Off, owned by the original room and device.
 * Contains no authority secret and cannot recover an On after a reload. */
export class RecordingStopJournal {
  readonly #key: string
  constructor(private readonly store: DeviceStore, private readonly room: string,
    participant: string, device: string, private readonly authority: string) {
    for (const value of [room, participant, device, authority]) {
      if (!/^[0-9a-f]{64}$/.test(value)) throw new Error('Invalid recording stop owner')
    }
    this.#key = `kithmoot.recording-stop.v1.${room}.${participant}.${device}.${authority}`
  }
  pending(): SignedRecordingOff | undefined {
    const raw = this.store.get(this.#key)
    if (raw === null) return undefined
    const message = decodeControl(raw)
    if (message?.op !== 'recording' || message.on ||
        !verifyRecordingNotice({ roomId: this.room, notice: message, sig: message.sig, authority: this.authority })) {
      throw new Error('The saved recording stop needs recovery')
    }
    return { ...message, on: false }
  }
  arm(off: SignedRecordingOff): void {
    if (off.on || !verifyRecordingNotice({ roomId: this.room, notice: off, sig: off.sig, authority: this.authority }))
      throw new Error('The recording stop is not authorised')
    const before = this.pending()
    if (before && (before.id !== off.id || before.version !== off.version || before.sig !== off.sig))
      throw new Error('Confirm the previous recording stop before starting another recording')
    this.store.set(this.#key, JSON.stringify(off))
    const saved = this.pending()
    if (!saved || saved.id !== off.id || saved.version !== off.version || saved.sig !== off.sig)
      throw new Error('This device could not retain the recording stop')
  }
  confirm(off: SignedRecordingOff): void {
    const before = this.pending()
    if (before?.id === off.id && before.version === off.version && before.sig === off.sig) this.store.remove(this.#key)
  }
}
