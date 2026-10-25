import { expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const script = readFileSync(new URL('../public/original-artwork-sw.js', import.meta.url), 'utf8')
type InstallEvent = { waitUntil: (promise: Promise<void>) => void }

function install(self: unknown) {
  let handler: ((event: InstallEvent) => void) | undefined
  const registration = self as { addEventListener: (type: string, callback: typeof handler) => void }
  registration.addEventListener = (_type, callback) => { handler = callback }
  runInNewContext(script, { self, URL })
  return handler!
}

async function runInstall(handler: (event: InstallEvent) => void) {
  let pending: Promise<void> | undefined
  handler({ waitUntil: promise => { pending = promise } })
  expect(pending).toBeDefined()
  await pending
}

function oldCache(entries: Array<[string, string]>) {
  const rows = entries.map(([url, body]) => ({ request: new Request(url), response: new Response(body) }))
  return {
    keys: async () => rows.map(row => row.request),
    match: async (request: Request) => rows.find(row => row.request.url === request.url)?.response,
  }
}

it('migrates only cached original artwork, strips only the Workbox revision and never fetches', async () => {
  const precacheName = 'workbox-precache-v2-https://example.test/j/'
  const old = oldCache([
    ['https://example.test/j/chat-art/coffee.gif?__WB_REVISION__=old&keep=1', 'coffee'],
    ['https://example.test/j/chat-art/legacy.gif?__WB_REVISION__=old', 'legacy'],
    ['https://example.test/j/emoji/happy.png?__WB_REVISION__=old', 'happy'],
    ['https://example.test/j/assets/main.js?__WB_REVISION__=old', 'javascript'],
    ['https://other.example/j/chat-art/coffee.gif?__WB_REVISION__=old', 'other origin'],
  ])
  const migrated = new Map<string, Response>(), opened: string[] = []
  const self = {
    registration: { scope: 'https://example.test/j/' },
    caches: {
      keys: async () => [precacheName, 'kithmoot-original-artwork-v1', 'unrelated-cache'],
      open: async (name: string) => {
        opened.push(name)
        if (name === precacheName) return old
        if (name === 'kithmoot-original-artwork-v1') return { put: async (url: string, response: Response) => { migrated.set(url, response) } }
        throw new Error(`Inspected unrelated cache: ${name}`)
      },
    },
    fetch: () => { throw new Error('Migration must not fetch.') },
  }
  await runInstall(install(self))
  expect(opened).toEqual([precacheName, 'kithmoot-original-artwork-v1'])
  expect([...migrated.keys()].sort()).toEqual([
    'https://example.test/j/chat-art/coffee.gif?keep=1',
    'https://example.test/j/chat-art/legacy.gif',
    'https://example.test/j/emoji/happy.png',
  ])
  expect(await migrated.get('https://example.test/j/chat-art/legacy.gif')!.text()).toBe('legacy')
})

it('does nothing on a fresh profile', async () => {
  const self = {
    registration: { scope: 'https://example.test/j/' },
    caches: {
      keys: async () => [],
      open: async () => { throw new Error('A fresh install needs no migration cache.') },
    },
  }
  await runInstall(install(self))
})

it('rejects installation when a migration cache write fails', async () => {
  const precacheName = 'workbox-precache-v2-https://example.test/j/'
  const self = {
    registration: { scope: 'https://example.test/j/' },
    caches: {
      keys: async () => [precacheName],
      open: async (name: string) => name === precacheName
        ? oldCache([['https://example.test/j/chat-art/coffee.gif?__WB_REVISION__=old', 'coffee']])
        : { put: async () => { throw new Error('quota exceeded') } },
    },
  }
  await expect(runInstall(install(self))).rejects.toThrow('quota exceeded')
})
