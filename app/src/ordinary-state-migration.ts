import { OrdinaryStateHold, type OrdinaryMigration } from './ordinary-state-codec.js'
import { OrdinaryStateOwner } from './ordinary-state-owner.js'

const MIGRATION_LOCK = 'kithmoot-ordinary-state-v1:migration'
function hold(): never { throw new OrdinaryStateHold() }
/** Enumerate actual Storage, never infer emptiness from a parsing failure. */
function snapshot(storage: Storage, selected: (name: string) => boolean): Map<string, string> {
  const records = new Map<string, string>()
  for (let index = 0; index < storage.length; index++) {
    const name = storage.key(index)
    if (name === null) hold()
    if (!selected(name)) continue
    if (records.has(name)) hold()
    const value = storage.getItem(name)
    if (value === null) hold()
    records.set(name, value)
  }
  return records
}
function checkLegacy(actual: ReadonlyMap<string, string>, manifest: OrdinaryMigration): void {
  for (const [name, value] of actual) {
    // A name cleaned in a prior committed manifest cannot reappear, even
    // byte-exactly. Changed values and newly selected names also hold.
    if (!manifest.sources.has(name) || manifest.sources.get(name) !== value) hold()
  }
}
/** Reconciles the cross-store migration before the app can load identities or
 * start any effect. The embedding must perform the real client-version fence
 * through checkClients and supply strict validators for its complete legacy
 * inventory. Tests of this function do not establish that client handshake. */
export async function migrateOrdinaryStorage(options: {
  owner: OrdinaryStateOwner
  storage: Storage
  selected(name: string): boolean
  validate(name: string, value: string): void
  checkClients(): Promise<void>
  live(): boolean
}): Promise<void> {
  const { owner, storage, selected, validate, checkClients, live } = options
  if (!navigator.locks) hold()
  await navigator.locks.request(MIGRATION_LOCK, async () => {
    const check = () => { if (!live()) hold() }
    check(); await checkClients(); check()
    const initial = snapshot(storage, selected)
    for (const [name, value] of initial) validate(name, value)
    await owner.prepare(live, initial, { phase: 'sealed', sources: initial, names: [...initial.keys()] })
    check()
    const scope = await owner.capture('@migration', live)
    const loaded = await owner.migration(scope, live)
    if (!loaded) hold()
    let manifest: OrdinaryMigration = loaded
    checkLegacy(snapshot(storage, selected), manifest)
    if (manifest.phase === 'complete') {
      await checkClients(); check()
      if (snapshot(storage, selected).size !== 0) hold()
      return
    }
    // Authenticate the image again before deleting any selected plaintext.
    await owner.read(scope, live, store => {
      for (const [name, value] of manifest!.sources) if (store.get(name) !== value) hold()
    })
    if (manifest.phase === 'sealed') {
      manifest = { ...manifest, phase: 'cleaning', sources: new Map(manifest.sources), names: [...manifest.names] }
      await owner.retainMigration(scope, live, manifest)
    }
    for (const [name, value] of [...manifest.sources]) {
      check(); await checkClients(); check()
      checkLegacy(snapshot(storage, selected), manifest)
      const current = storage.getItem(name)
      if (current !== null && current !== value) hold()
      if (current !== null) storage.removeItem(name)
      if (storage.getItem(name) !== null) hold()
      // A crash before this commit leaves an absent pending source, accepted
      // only after the authenticated full image is reopened above. A committed
      // cleanup marker makes any subsequent reappearance a hold.
      const sources = new Map(manifest.sources); sources.delete(name)
      const candidate: OrdinaryMigration = { ...manifest, sources }
      await owner.retainMigration(scope, live, candidate)
      manifest = candidate
    }
    checkLegacy(snapshot(storage, selected), manifest)
    await checkClients(); check()
    if (snapshot(storage, selected).size !== 0) hold()
    await owner.retainMigration(scope, live, { phase: 'complete', sources: new Map(), names: [...manifest.names] })
    check(); await checkClients(); check()
    if (snapshot(storage, selected).size !== 0) hold()
  })
}
