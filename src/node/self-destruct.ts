import { rm } from 'node:fs/promises'
import { sha256 } from '@noble/hashes/sha2'
import { utf8ToBytes } from '@noble/hashes/utils'
import type { RoomAgent } from '../agent.js'

/**
 * What kithmoot-agent does when a self-destructing room is over: the room's
 * events it signed are asked off the relays, and every file it kept for the
 * room is deleted. Anything a brain or an MCP client wrote elsewhere is
 * outside its reach; see docs/agents.md.
 */

/** The files and directories kept for one room. */
export interface RoomFiles {
  /** Each removed with `force`: a file already gone is fine. */
  files: string[]
  /** Each removed with everything under it. */
  dirs: string[]
}

/**
 * A keeper's device key for a self-destructing room, derived from its
 * identity and the room's id, so a restarted keeper signs as the device it was and
 * can still ask for everything it ever signed to be deleted. Other rooms get
 * other keys, so a relay still cannot follow the keeper from room to room.
 */
export function destructDeviceKey(identitySk: Uint8Array, roomId: string): Uint8Array {
  return sha256(new Uint8Array([...utf8ToBytes('kithmoot-agent/destruct-device/v1\0'), ...identitySk, ...utf8ToBytes(roomId)]))
}

/** Remove the room's files. Never throws: what cannot be removed is returned. */
export async function removeRoomFiles(room: RoomFiles): Promise<string[]> {
  const left: string[] = []
  for (const path of room.files) await rm(path, { force: true }).catch(() => { left.push(path) })
  for (const path of room.dirs) await rm(path, { force: true, recursive: true }).catch(() => { left.push(path) })
  return left
}

export interface SelfDestructSteps {
  agent: Pick<RoomAgent, 'deleteOwnEvents'>
  /** Stop everything that is reading or writing for the room. Bounded by `boundMs`. */
  stop: () => Promise<void>
  files: () => RoomFiles
  /** Called last, once the files have gone: release a lock, say so. */
  done?: () => void
  log: (line: string) => void
  /** Bounds each wait. Default 5 seconds. */
  boundMs?: number
  /** Bounds the relay deletion. Default 15 seconds. */
  deletionMs?: number
}

const bounded = <T>(work: Promise<T>, ms: number): Promise<T | undefined> =>
  Promise.race([work, new Promise<undefined>((resolve) => { (setTimeout(resolve, ms) as unknown as { unref?: () => void }).unref?.() })])

/** The wipe, once: a second call waits for the first. */
export function selfDestructOnce(steps: SelfDestructSteps): (why: string) => Promise<void> {
  let running: Promise<void> | undefined
  return (why) => (running ??= (async () => {
    const { log } = steps
    const boundMs = steps.boundMs ?? 5_000
    log(`room self-destructing (${why})`)
    await bounded(steps.stop().catch(() => {}), boundMs)
    const report = await steps.agent.deleteOwnEvents({ timeoutMs: steps.deletionMs ?? 15_000 }).catch(() => undefined)
    log(report
      ? `asked the relays to delete ${report.requested} of ${report.found} events${report.failed ? `, ${report.failed} could not be asked` : ''}${report.complete ? '' : ', not every relay answered in time'}`
      : 'could not ask the relays to delete this agent’s events')
    const left = await removeRoomFiles(steps.files())
    if (left.length) log(`could not remove ${left.length} file${left.length === 1 ? '' : 's'}: delete them by hand`)
    steps.done?.()
  })())
}
