/**
 * Which call a device with live media and no call should say it is on.
 *
 * The room's current call, if one is visible. A fresh one only when the
 * person asked for this device to be on a call - Join, or switching a
 * microphone, camera or share on - since they last pressed Leave. Never
 * otherwise: a fresh id is a new call, and a new call rings every phone in
 * the room in this person's name. A device that cannot see the call it was
 * on, because a relay is a beat behind, or that finds a track still live
 * after Leave, has no business starting one nobody asked for.
 */
export function callToDeclare(visible: string | undefined, wanted: boolean, fresh: () => string): string | undefined {
  if (visible) return visible
  return wanted ? fresh() : undefined
}
