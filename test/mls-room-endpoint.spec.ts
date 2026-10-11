import { test, expect, type BrowserContext } from '@playwright/test'
import { build } from 'esbuild'
const origin = 'https://mls-room-endpoint.kithmoot.test'
let bundle: string
test.beforeAll(async () => { bundle = (await build({ entryPoints: ['test/mls-room-endpoint.browser-entry.ts'], bundle: true, write: false, format: 'iife', globalName: 'E', define: { 'import.meta.env.BASE_URL': '"/"' } })).outputFiles[0].text })
async function fixture(context: BrowserContext) {
  await context.route(origin + '/**', route => route.fulfill({ contentType: 'text/html', body: `<script>${bundle}</script>` }))
  const page = await context.newPage(); await page.goto(origin); return page
}
test('outside room scope cannot open storage or start an endpoint', async ({ context }) => {
  const page = await fixture(context)
  expect(await page.evaluate('E.outside()')).toBe(false)
  expect(await page.evaluate('indexedDB.databases()')).toEqual([])
  expect(await page.evaluate('E.status()')).toMatchObject({ starts: 0 })
})
test('room custody pairs and resumes without preparing any grant database', async ({ context }) => {
  const page = await fixture(context)
  expect(await page.evaluate("E.workflow('setup')")).toMatchObject({ state: 'done' })
  const before = await page.evaluate('E.inspect()') as any
  expect(before).toMatchObject({ key: true, extractable: false, record: true })
  expect(before.databases).toHaveLength(2)
  const account = await page.evaluate('E.account()') as string
  expect(before.databases.every((name: string) => !name.includes(account))).toBe(true)
  const seed = (await page.evaluate('E.status()') as any).seed
  expect(await page.evaluate('E.workflow()')).toMatchObject({ state: 'done' })
  expect((await page.evaluate('E.status()') as any).seed).toEqual(seed)
  expect((await page.evaluate('E.inspect()') as any).cipher).toEqual(before.cipher)
  expect((await page.evaluate('navigator.locks.query()') as any).held).toEqual([])
})
test('legacy grant custody remains byte-for-byte unchanged by room pairing and saved route reads', async ({ context }) => {
  const page = await fixture(context)
  await page.evaluate('E.seedGrantSentinel()')
  const before = await page.evaluate('E.grantSentinel()')
  await page.evaluate("E.workflow('setup')"); await page.evaluate('E.saved()')
  expect(await page.evaluate('E.grantSentinel()')).toEqual(before)
})
test('the private concrete owner reads saved routes without a grant database or engine override', async ({ context }) => {
  const page = await fixture(context)
  expect(await page.evaluate('E.concreteSavedRoutes()')).toEqual({ state: 'done', value: [] })
  expect((await page.evaluate('indexedDB.databases()') as { name: string }[]).every(db => db.name.startsWith('kithmoot-vmls-room-link-v1:'))).toBe(true)
  expect(await page.evaluate('E.status()')).toMatchObject({ starts: 0 })
})
for (const at of ['start', 'pair', 'request', 'signer', 'stop', 'encrypt']) test(`late ${at} work retains actual native room ownership until settlement`, async ({ context }) => {
  const page = await fixture(context)
  if (at === 'request') await page.evaluate("E.workflow('setup')")
  if (at === 'encrypt') await page.evaluate('E.holdEncryption()')
  else await page.evaluate(at => (window as any).E.configure(at), at)
  const action = at === 'pair' ? 'setup' : at === 'request' || at === 'signer' ? at : 'resume'
  await page.evaluate(action => { (window as any).work = (window as any).E.workflow(action).then((value: unknown) => ({ value }), (error: Error) => ({ error: error.message })) }, action)
  await expect.poll(() => page.evaluate('E.status()')).toMatchObject({ reached: true })
  await page.evaluate('E.invalidate()')
  expect(await page.evaluate('navigator.locks.request(E.ownerKey(), {ifAvailable:true}, lock => !!lock)')).toBe(false)
  await page.evaluate('E.releaseWork()')
  expect(await page.evaluate('window.work')).toMatchObject({ value: { state: 'interrupted' } })
  await page.evaluate('E.settled()')
  expect((await page.evaluate('navigator.locks.query()') as any).held).toEqual([])
})
test('failed engine stop keeps the native room lock and refuses reopening', async ({ context }) => {
  const page = await fixture(context)
  await page.evaluate("E.configure('', 'normal', true)")
  await expect(page.evaluate('E.workflow()')).rejects.toThrow()
  expect(await page.evaluate('navigator.locks.request(E.ownerKey(), {ifAvailable:true}, lock => !!lock)')).toBe(false)
  await expect(page.evaluate('E.stopAgain()')).rejects.toThrow()
  await expect(page.evaluate('E.workflow()')).rejects.toThrow()
  expect(await page.evaluate('E.status()')).toMatchObject({ starts: 1, stops: 1 })
})
test('a second tab cannot take room ownership during a late request', async ({ context }) => {
  const first = await fixture(context), second = await fixture(context)
  await first.evaluate("E.workflow('setup')")
  await first.evaluate("E.configure('request'); void(window.work = E.workflow('request'))")
  await expect.poll(() => first.evaluate('E.status()')).toMatchObject({ reached: true })
  await expect(second.evaluate('E.workflow()')).rejects.toThrow()
  expect(await second.evaluate('E.status()')).toMatchObject({ starts: 0 })
  await first.evaluate('E.releaseWork()'); await first.evaluate('window.work')
  expect(await second.evaluate('E.workflow()')).toMatchObject({ state: 'done' })
})
for (const fake of [false, true]) test(`room vault refuses ${fake ? 'structural endpoint' : 'writes without native endpoint ownership'}`, async ({ context }) => {
  const page = await fixture(context)
  await expect(page.evaluate(fake => (window as any).E.outsideOwnershipWrite(fake), fake)).rejects.toThrow()
  expect(await page.evaluate('indexedDB.databases()')).toEqual([])
})
for (const kind of ['null', 'false', 'wrong-key', 'cross-account', 'cross-grant']) test(`room custody refuses and retains ${kind} seals`, async ({ context }) => {
  const page = await fixture(context)
  await page.evaluate('E.workflow()')
  const cipher = await page.evaluate(kind => (window as any).E.corrupt(kind), kind)
  await expect(page.evaluate('E.saved()')).rejects.toThrow()
  expect((await page.evaluate('E.inspect()') as any).cipher).toEqual(cipher)
})
for (const privacy of ['quiet', 'tor-only']) test(`concrete room owner holds ${privacy} pairing before storage or WASM`, async ({ context }) => {
  const page = await fixture(context)
  expect(await page.evaluate(privacy => (window as any).E.roomOwnerQuiet(privacy), privacy)).toBe(false)
  expect(await page.evaluate('indexedDB.databases()')).toEqual([])
  expect(await page.evaluate('E.status()')).toMatchObject({ starts: 0 })
})
test('the forget guard creates no persistent custody and bars a late first seed or saved-route read', async ({ context }) => {
  const first = await fixture(context), second = await fixture(context)
  await first.evaluate("E.configure('forget'); void(window.work = E.forgetGuard())")
  await expect.poll(() => first.evaluate('E.status()')).toMatchObject({ reached: true })
  await expect(second.evaluate('E.workflow()')).rejects.toThrow()
  await expect(second.evaluate('E.saved()')).rejects.toThrow()
  expect(await first.evaluate('indexedDB.databases()')).toEqual([])
  await first.evaluate('E.releaseWork()'); expect(await first.evaluate('window.work')).toBe(true)
  expect(await second.evaluate('E.workflow()')).toMatchObject({ state: 'done' })
  expect(await first.evaluate('E.forgetGuard()')).toBe(false)
})
for (const kind of ['null', 'missing', 'extractable', 'replacement']) test(`opaque naming ${kind} custody is refused without replacing sealed room bytes`, async ({ context }) => {
  const page = await fixture(context)
  await page.evaluate('E.workflow()')
  const before = await page.evaluate(kind => (window as any).E.corruptNames(kind), kind) as { name: string; cipher: number[]; databases: string[] }
  await expect(page.evaluate('E.saved()')).rejects.toThrow()
  await expect(page.evaluate("E.workflow('setup')")).rejects.toThrow()
  expect(await page.evaluate(name => (window as any).E.retained(name), before.name)).toEqual(before.cipher)
  expect(await page.evaluate('indexedDB.databases().then(databases => databases.map(db => db.name).sort())')).toEqual(before.databases)
  expect(await page.evaluate('E.forgetGuard()')).toBe(false)
})
for (const replacement of ['mutateSigner', 'changeAccount']) test(`late request refuses ${replacement} and releases actual native ownership`, async ({ context }) => {
  const page = await fixture(context)
  await page.evaluate("E.workflow('setup')")
  await page.evaluate("E.configure('request'); void(window.work = E.workflow('request').then(value => ({value}), error => ({error:error.message})))")
  await expect.poll(() => page.evaluate('E.status()')).toMatchObject({ reached: true })
  await page.evaluate(replacement => { (window as any).E[replacement](); (window as any).E.releaseWork() }, replacement)
  expect(await page.evaluate('window.work')).toHaveProperty('error')
  expect((await page.evaluate('navigator.locks.query()') as any).held).toEqual([])
})
for (const kind of ['one', 'unchanged', 'changed-seed', 'changed-account', 'multiple', 'drop']) test(`room custody ${kind} transition preserves saved authority`, async ({ context }) => {
  const page = await fixture(context)
  await page.evaluate("E.workflow('setup')")
  const before = (await page.evaluate('E.inspect()') as any).cipher
  if (kind === 'one') {
    expect(await page.evaluate(kind => (window as any).E.transition(kind), kind)).toMatchObject({ state: 'done' })
    expect((await page.evaluate('E.inspect()') as any).cipher).not.toEqual(before)
    expect(await page.evaluate('E.saved()')).toMatchObject({ state: 'done', value: expect.any(Array) })
  } else {
    await expect(page.evaluate(kind => (window as any).E.transition(kind), kind)).rejects.toThrow()
    expect((await page.evaluate('E.inspect()') as any).cipher).toEqual(before)
  }
  expect((await page.evaluate('navigator.locks.query()') as any).held).toEqual([])
})
