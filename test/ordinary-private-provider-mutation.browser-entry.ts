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
