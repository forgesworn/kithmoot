import { expect, test, type Page } from '@playwright/test'

const origin = 'https://native-lock-release.kithmoot.test'
const cycles = 32
const lockName = 'vennel-native-release-order-diagnostic-v1'

/** An isolated native API probe. There is no BrowserLink, vault, storage,
 * application bundle, ownership substitute, retry, steal or acquisition poll. */
test('native released promise precedes one immediate cross-page acquisition', async ({ browser }, info) => {
  const context = await browser.newContext()
  let phase = 'setup', cycle = 0, completedCycles = 0
  let nativeRefusalAfterReleasedPromise = false
  const postFailure = async (page: Page) => {
    try {
      return await page.evaluate(async name => {
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          return await Promise.race([
            navigator.locks.query().then(snapshot => ({
              held: snapshot.held?.filter(value => value.name === name).length ?? 0,
              pending: snapshot.pending?.filter(value => value.name === name).length ?? 0,
            })),
            new Promise<{ timedOut: true }>(resolve => { timer = setTimeout(() => resolve({ timedOut: true }), 500) }),
          ])
        } catch { return { unavailable: true } }
        finally { if (timer !== undefined) clearTimeout(timer) }
      }, lockName)
    } catch { return { unavailable: true } }
  }
  let a: Page | undefined, b: Page | undefined
  try {
    await context.route(`${origin}/**`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Native lock probe</title>' }))
    a = await context.newPage(); b = await context.newPage()
    for (const page of [a, b]) {
      await page.goto(origin)
      await page.evaluate(name => {
        let held: Promise<void> | undefined, release: (() => void) | undefined
        const channel = new BroadcastChannel(name)
        let armed: { token: number; used: boolean; result: Promise<boolean>; resolve(value: boolean): void; reject(error: unknown): void } | undefined
        const probe = {
          async acquire(): Promise<boolean> {
            if (held || release) throw Error('Native probe already has an acquisition')
            let acquired!: (value: boolean) => void, acquisitionFailed!: (error: unknown) => void
            const entered = new Promise<boolean>((resolve, reject) => { acquired = resolve; acquisitionFailed = reject })
            const waiting = new Promise<void>(resolve => { release = resolve })
            const pending = navigator.locks.request<void>(name, { ifAvailable: true }, lock => {
              acquired(lock !== null)
              return lock ? waiting : undefined
            })
            held = pending
            void pending.catch(acquisitionFailed)
            const available = await entered
            if (!available) { await pending; held = undefined; release = undefined }
            return available
          },
          async release(): Promise<void> {
            if (!held || !release) throw Error('Native probe has no acquired lock')
            const pending = held, finish = release
            release = undefined
            finish()
            // Await the actual native request promise, not just the waiting
            // callback promise. No query or other barrier follows this await.
            await pending
            held = undefined
          },
          arm(token: number): void {
            if (armed || !Number.isInteger(token) || token < 1 || token > 64) throw Error('Native probe arm refused')
            let resolve!: (value: boolean) => void, reject!: (error: unknown) => void
            const result = new Promise<boolean>((yes, no) => { resolve = yes; reject = no })
            void result.catch(() => {})
            armed = { token, used: false, result, resolve, reject }
          },
          async readArmed(): Promise<boolean> {
            const value = armed
            if (!value) throw Error('Native probe is not armed')
            try { return await value.result }
            finally { if (armed === value) armed = undefined }
          },
          async releaseAndNotify(token: number): Promise<void> {
            await probe.release()
            // The receiving page is already armed. This browser-local message
            // starts its one acquisition, without a Node or query handoff.
            channel.postMessage(token)
          },
          closeChannel(): void { channel.close() },
        }
        channel.onmessage = event => {
          const value = armed
          if (!value || value.used || event.data !== value.token) return
          value.used = true
          // acquire calls the native request synchronously before its first
          // await. No native query, timer or Node command intervenes here.
          void probe.acquire().then(value.resolve, value.reject)
        }
        channel.onmessageerror = () => armed?.reject(Error('Native probe message failed'))
        Object.defineProperty(window, '__nativeReleaseProbe', { value: probe })
      }, lockName)
    }
    const acquire = (page: Page) => page.evaluate(() => (window as any).__nativeReleaseProbe.acquire() as Promise<boolean>)
    const release = (page: Page) => page.evaluate(() => (window as any).__nativeReleaseProbe.release() as Promise<void>)
    phase = 'initial-a-acquire'
    expect(await acquire(a)).toBe(true)
    for (cycle = 1; cycle <= cycles; cycle++) {
      phase = 'b-denied-while-a-held'
      expect(await acquire(b)).toBe(false)
      phase = 'arm-b-before-a-release'
      await b.evaluate(token => (window as any).__nativeReleaseProbe.arm(token), cycle * 2 - 1)
      phase = 'b-page-side-acquire-after-a-released'
      const [bAvailable] = await Promise.all([
        b.evaluate(() => (window as any).__nativeReleaseProbe.readArmed() as Promise<boolean>),
        a.evaluate(token => (window as any).__nativeReleaseProbe.releaseAndNotify(token) as Promise<void>, cycle * 2 - 1),
      ])
      if (!bAvailable) nativeRefusalAfterReleasedPromise = true
      expect(bAvailable, `B page-side acquisition after A released promise at cycle ${cycle}`).toBe(true)
      phase = 'arm-a-before-b-release'
      await a.evaluate(token => (window as any).__nativeReleaseProbe.arm(token), cycle * 2)
      phase = 'a-page-side-acquire-after-b-released'
      const [aAvailable] = await Promise.all([
        a.evaluate(() => (window as any).__nativeReleaseProbe.readArmed() as Promise<boolean>),
        b.evaluate(token => (window as any).__nativeReleaseProbe.releaseAndNotify(token) as Promise<void>, cycle * 2),
      ])
      if (!aAvailable) nativeRefusalAfterReleasedPromise = true
      expect(aAvailable, `A page-side acquisition after B released promise at cycle ${cycle}`).toBe(true)
      completedCycles++
    }
    await release(a)
    await Promise.all([a, b].map(page => page.evaluate(() => (window as any).__nativeReleaseProbe.closeChannel())))
    phase = 'completed'
    console.log('NATIVE_LOCK_RELEASE_ORDER ' + JSON.stringify({ engine: info.project.name, phase, completedCycles,
      expectedCycles: cycles, expectedReleaseHandoffs: 64, nativeRefusalAfterReleasedPromise, queryOnPassingPath: false,
      historicalCauseEstablished: false, historicalFailureWaived: false }))
  } catch (error) {
    // Observe only after the tested acquisition has already refused. Stop at
    // this first failure; no acquisition is retried and the error is rethrown.
    const observed = await Promise.all([a ? postFailure(a) : null, b ? postFailure(b) : null])
    console.log('NATIVE_LOCK_RELEASE_ORDER ' + JSON.stringify({ engine: info.project.name, phase, cycle,
      completedCycles, expectedCycles: cycles, expectedReleaseHandoffs: 64, nativeRefusalAfterReleasedPromise, observed,
      historicalCauseEstablished: false, historicalFailureWaived: false }))
    throw error
  } finally { await context.close() }
})
