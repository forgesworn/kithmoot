import { verifyEvent, verifiedSymbol, type Event } from 'nostr-tools/pure'

/**
 * Verify an event's signature, ignoring any cached verdict it arrives with.
 *
 * `verifyEvent` caches its result on the event object under `verifiedSymbol`
 * and returns that cached value on any later call, without re-checking
 * anything. The property is an own enumerable symbol, so it survives a
 * shallow copy (`{ ...event }`, which is exactly how a caller might rebuild
 * an event after editing a field) - and an attacker who hands us an object
 * rather than a JSON string can simply set it themselves. Either way the
 * signature check silently becomes a no-op.
 *
 * Every inbound event in this library goes through here rather than calling
 * `verifyEvent` directly, so the defence cannot be forgotten by the next
 * decoder somebody writes. The copy also keeps the caller's object
 * unmodified: we never stamp a verdict onto something we did not sign.
 */
export function verifyEventUncached(event: Event): boolean {
  const unverified = { ...event }
  delete unverified[verifiedSymbol]
  return verifyEvent(unverified)
}
