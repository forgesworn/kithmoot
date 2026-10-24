import type { RoomSession } from '../../src/session.js'

/** Ephemeral presence arrives in replies to joining, after the join itself.
 * Give those replies time before creating a second call in the same room. */
export async function waitForExistingCall(session: Pick<RoomSession, 'calls' | 'onChange' | 'closed'>, readyAt: number): Promise<void> {
  const remaining = readyAt - Date.now()
  if (remaining <= 0 || session.closed || session.calls().length) return
  await new Promise<void>(resolve => {
    const finish = () => { clearTimeout(timer); stop(); resolve() }
    const timer = setTimeout(finish, remaining)
    const stop = session.onChange(() => { if (session.closed || session.calls().length) finish() })
  })
}
