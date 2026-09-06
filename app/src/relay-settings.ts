import { NostrRelayPool, normaliseRelayConfig, type RelayConfig, type RelayHealth } from '../../src/relay-pool.js'

const STORAGE_KEY = 'kithmoot.relays.v1'
type StorageLike = Pick<Storage, 'getItem' | 'setItem'>
type RelayHints = (string | RelayConfig)[]

/** Device preferences, separate from relay hints shared in an invitation. */
export class RelayConnections {
  #saved: Record<string, RelayConfig[]> = {}
  #pools = new Map<NostrRelayPool, { scope: string; hints: RelayHints }>()
  constructor(private storage: StorageLike, private defaults: string[]) {
    try {
      const saved: unknown = JSON.parse(storage.getItem(STORAGE_KEY) ?? '{}')
      if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
        for (const [scope, entries] of Object.entries(saved)) {
          if (!Array.isArray(entries) || !this.#validScope(scope)) continue
          try { this.#saved[scope] = normaliseRelayConfig(entries) } catch { /* Ignore invalid saved settings. */ }
        }
      }
    } catch { /* Storage may be unavailable or contain an older shape. */ }
  }
  #validScope(scope: string): boolean { return scope === 'default' || /^room:[a-f0-9]{64}$/.test(scope) }
  configuration(scope: string, hints: RelayHints = []): RelayConfig[] {
    const entries = this.#saved[scope] ?? (hints.length ? hints : this.#saved.default ?? this.defaults)
    return normaliseRelayConfig(entries)
  }
  pool(scope: string, hints: RelayHints = []): NostrRelayPool {
    this.#prune()
    const pool = new NostrRelayPool(this.configuration(scope, hints))
    this.#pools.set(pool, { scope, hints })
    return pool
  }
  save(scope: string, entries: RelayConfig[]): void {
    if (!this.#validScope(scope)) throw new Error('No room is selected')
    const relays = normaliseRelayConfig(entries)
    if (!relays.some(relay => relay.read) || !relays.some(relay => relay.write)) throw new Error('Keep at least one readable relay and one writable relay so the room can receive and send messages.')
    const next = { ...this.#saved, [scope]: relays }
    // Do not claim persistence or change connections if saving failed.
    this.storage.setItem(STORAGE_KEY, JSON.stringify(next))
    this.#saved = next
    this.#prune()
    for (const [pool, owner] of this.#pools) {
      if (owner.scope === scope || (scope === 'default' && !owner.hints.length && !this.#saved[owner.scope])) pool.setRelays(this.configuration(owner.scope, owner.hints))
    }
  }
  reconnect(scope: string): void {
    this.#prune()
    for (const [pool, owner] of this.#pools) if (owner.scope === scope) pool.reconnect()
  }
  health(scope: string, hints: RelayHints = []): RelayHealth[] {
    this.#prune()
    return this.configuration(scope, hints).map(relay => {
      const matches = [...this.#pools].filter(([, owner]) => owner.scope === scope).flatMap(([pool]) => pool.health()).filter(health => health.url === relay.url)
      const connected = matches.some(health => health.state === 'connected')
      const lastWrite = matches.filter(health => health.lastPublishedAt).sort((a, b) => b.lastPublishedAt! - a.lastPublishedAt!)[0]
      const failed = matches.find(health => health.lastError)
      return { ...lastWrite, ...relay, lastError: failed?.lastError,
        state: connected ? 'connected' : matches.some(health => health.state === 'connecting') ? 'connecting'
          : matches.some(health => health.state === 'disconnected') ? 'disconnected' : 'idle' }
    })
  }
  #prune(): void { for (const pool of this.#pools.keys()) if (pool.closed) this.#pools.delete(pool) }
}

export function profilePreference(storage: Pick<Storage, 'getItem'>): boolean {
  try { return storage.getItem('kithmoot.profiles.enabled') !== 'false' } catch { return true }
}

export class RelaySettingsPanel {
  #scope = 'default'
  #draft: RelayConfig[] = []
  #timer?: ReturnType<typeof setInterval>
  #returnFocus?: HTMLElement
  constructor(private document: Document, private connections: RelayConnections, private opts: {
    room: () => { scope: string; hints: RelayHints } | undefined
    applied: (scope: string, relays: RelayConfig[]) => void
  }) {
    this.el('relaySettingsClose').addEventListener('click', () => this.dialog.close())
    this.dialog.addEventListener('close', () => { clearInterval(this.#timer); this.#returnFocus?.focus() })
    this.el('relayScope').addEventListener('change', () => { this.#scope = (this.el('relayScope') as HTMLSelectElement).value; this.#load() })
    this.el('relayAddForm').addEventListener('submit', event => {
      event.preventDefault()
      const input = this.el('relayUrl') as HTMLInputElement
      const mode = (this.el('relayMode') as HTMLSelectElement).value
      try {
        this.#draft = normaliseRelayConfig([...this.#draft, { url: input.value, read: mode !== 'write', write: mode !== 'read' }])
        input.value = ''; this.#render(); this.#message('Relay added to the list. Apply changes to connect.')
      } catch (error) { this.#message((error as Error).message) }
    })
    this.el('relaySave').addEventListener('click', () => {
      try {
        this.connections.save(this.#scope, this.#draft)
        this.opts.applied(this.#scope, this.#draft)
        this.#load(); this.#message('Saved on this device. Connections updated.')
      } catch (error) { this.#message((error as Error).message) }
    })
    this.el('relayReconnect').addEventListener('click', () => {
      this.connections.reconnect(this.#scope); this.#health(); this.#message('Retrying the saved relay connections.')
    })
  }
  private el(id: string): HTMLElement { return this.document.getElementById(id)! }
  private get dialog(): HTMLDialogElement { return this.el('relaySettings') as HTMLDialogElement }
  open(from: HTMLElement): void {
    this.#returnFocus = from
    const room = this.opts.room()
    const scope = this.el('relayScope') as HTMLSelectElement
    scope.replaceChildren()
    if (room) scope.add(new Option('This room', room.scope))
    scope.add(new Option('Defaults for new rooms and account sync', 'default'))
    this.#scope = room?.scope ?? 'default'; scope.value = this.#scope
    this.#load(); this.dialog.showModal(); scope.focus()
    clearInterval(this.#timer); this.#timer = setInterval(() => this.#health(), 1000)
  }
  #hints(): RelayHints { const room = this.opts.room(); return room?.scope === this.#scope ? room.hints : [] }
  #load(): void { this.#draft = this.connections.configuration(this.#scope, this.#hints()); this.#render(); this.#message('') }
  #message(text: string): void { this.el('relaySettingsStatus').textContent = text }
  #render(): void {
    const list = this.el('relayList'); list.replaceChildren()
    this.#draft.forEach((relay, index) => {
      const row = this.document.createElement('li'); row.className = 'relayRow'; row.dataset.url = relay.url
      const url = this.document.createElement('span'); url.className = 'relayAddress'; url.textContent = relay.url
      const health = this.document.createElement('span'); health.className = 'relayHealth'; health.setAttribute('aria-live', 'polite')
      const mode = this.document.createElement('select'); mode.setAttribute('aria-label', `Access for ${relay.url}`)
      for (const [value, label] of [['both', 'Read / write'], ['read', 'Read only'], ['write', 'Write only']]) mode.add(new Option(label, value))
      mode.value = relay.read && relay.write ? 'both' : relay.read ? 'read' : 'write'
      mode.addEventListener('change', () => { this.#draft[index] = { ...relay, read: mode.value !== 'write', write: mode.value !== 'read' }; this.#message('Access changed. Apply changes to use it.') })
      const remove = this.document.createElement('button'); remove.type = 'button'; remove.textContent = 'Remove'; remove.setAttribute('aria-label', `Remove ${relay.url}`)
      remove.addEventListener('click', () => { this.#draft.splice(index, 1); this.#render(); this.#message('Relay removed from the list. Apply changes to disconnect.') })
      row.append(url, health, mode, remove); list.append(row)
    })
    this.#health()
  }
  #health(): void {
    const health = this.connections.health(this.#scope, this.#hints())
    for (const row of this.el('relayList').querySelectorAll<HTMLElement>('.relayRow')) {
      const found = health.find(entry => entry.url === row.dataset.url)
      const text = row.querySelector<HTMLElement>('.relayHealth')!
      const labels = { connected: 'Connected', connecting: 'Connecting…', disconnected: 'Disconnected', closed: 'Closed', idle: 'Not connected yet' }
      text.textContent = found ? labels[found.state] : 'Not applied yet'
      text.dataset.state = found?.state ?? 'idle'
      if (found?.lastPublishedAt) text.textContent += ` · Last accepted write ${new Date(found.lastPublishedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })} (${found.publishLatencyMs} ms)`
      if (found?.lastError) text.textContent += ` · ${found.lastError}`
    }
  }
}
