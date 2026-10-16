// Explicit adversarial fixture only. Production cannot import this helper.
import { openOrdinaryFrame, sealOrdinaryImage } from '../app/src/ordinary-state-codec.js'
export async function advanceBrowserRevision(): Promise<void> {
  const fixture = (window as any).providerFixture
  const db = await new Promise<IDBDatabase>((yes, no) => {
    const r = indexedDB.open('kithmoot-ordinary-state-v1', 1)
    r.onsuccess = () => yes(r.result); r.onerror = () => no(r.error)
  })
  try {
    const row = await new Promise<any>((yes, no) => {
      const tx = db.transaction('owners'), r = tx.objectStore('owners').get('browser')
      let value: unknown
      r.onsuccess = () => { value = r.result }
      tx.oncomplete = () => yes(value); tx.onabort = () => no(tx.error)
    })
    const image = await openOrdinaryFrame(row.frame, row.key)
    try {
      image.revision++
      row.frame = await sealOrdinaryImage(image, row.key, {
        getRandomValues: fixture.nativeRandom, subtle: crypto.subtle,
      } as Crypto)
      await new Promise<void>((yes, no) => {
        const tx = db.transaction('owners', 'readwrite')
        fixture.nativePut.call(tx.objectStore('owners'), row, 'browser')
        tx.oncomplete = () => { fixture.mutations++; yes() }; tx.onabort = () => no(tx.error)
      })
    } finally { (image.records as Map<string, string>).clear(); (image.fences as Map<string, number>).clear() }
  } finally { db.close() }
}

/** Actual authenticated disk mutation by the adversarial fixture, never by
 * the join path. Preserve revision so refusal cannot rely on that alone. */
export async function changeBrowserEpochHistory(roomId: string, prefix: string, mode: 'missing-current' | 'pruned-proof'): Promise<void> {
  const fixture = (window as any).providerFixture
  const db = await new Promise<IDBDatabase>((yes, no) => {
    const request = indexedDB.open('kithmoot-ordinary-state-v1', 1)
    request.onsuccess = () => yes(request.result); request.onerror = () => no(request.error)
  })
  try {
    const row = await new Promise<any>((yes, no) => {
      const tx = db.transaction('owners'), request = tx.objectStore('owners').get('browser')
      let result: unknown
      request.onsuccess = () => {result = request.result}
      tx.oncomplete = () => yes(result); tx.onabort = () => no(tx.error)
    })
    const image = await openOrdinaryFrame(row.frame, row.key)
    try {
      const records = image.records as Map<string, string>, v1 = prefix + 'kithmoot.room-epoch.v1.' + roomId,
        v2 = prefix + 'kithmoot.room-epoch.v2.' + roomId
      const kept = JSON.parse(records.get(v2)!) as {epoch: number; past: {epoch: number}[]}
      if (kept.epoch !== 1 || !kept.past.some(value => value.epoch === 0)) throw Error('Epoch mutation fixture needs real durable 1 with past 0')
      if (mode === 'missing-current') {records.delete(v1); records.delete(v2)}
      else if (mode === 'pruned-proof') {kept.past = kept.past.filter(value => value.epoch !== 0); records.set(v2, JSON.stringify(kept))}
      else throw Error('Unknown history mutation fixture')
      row.frame = await sealOrdinaryImage(image, row.key, {getRandomValues: fixture.nativeRandom, subtle: crypto.subtle} as Crypto)
      // Decode the new authenticated frame independently before writing it.
      const checked = await openOrdinaryFrame(row.frame, row.key)
      try {
        if (mode === 'missing-current' ? checked.records.has(v1) || checked.records.has(v2) :
          JSON.parse(checked.records.get(v2)!).past.some((value: {epoch: number}) => value.epoch === 0)) throw Error('History mutation was not encoded')
      } finally {(checked.records as Map<string, string>).clear(); (checked.fences as Map<string, number>).clear()}
      await new Promise<void>((yes, no) => {
        const tx = db.transaction('owners', 'readwrite')
        fixture.nativePut.call(tx.objectStore('owners'), row, 'browser')
        tx.oncomplete = () => {fixture.historyMutationWrites = (fixture.historyMutationWrites ?? 0) + 1;
          fixture.historyMutation = {mode, revision: image.revision, authenticated: true}; yes()}
        tx.onabort = () => no(tx.error)
      })
    } finally {(image.records as Map<string, string>).clear(); (image.fences as Map<string, number>).clear()}
  } finally {db.close()}
}
