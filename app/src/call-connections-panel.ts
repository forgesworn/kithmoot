import type { observedCallConnection } from './call-connection.js'

export interface CallConnectionsSnapshot {
  room: string[]
  people: { name: string; devices: { label: string; connection: ReturnType<typeof observedCallConnection> }[] }[]
}

/** Poll only while open. No storage, clipboard export or network lookups. */
export class CallConnectionsPanel {
  #generation = 0
  #timer?: ReturnType<typeof setInterval>
  #reading = false
  constructor(private host: HTMLElement, private read: () => Promise<CallConnectionsSnapshot>) {}

  setOpen(open: boolean): void {
    clearInterval(this.#timer)
    this.#timer = undefined
    this.#generation++
    this.host.replaceChildren()
    if (!open) return
    void this.refresh()
    this.#timer = setInterval(() => void this.refresh(), 2000)
  }

  private async refresh(): Promise<void> {
    if (this.#reading) return
    this.#reading = true
    const generation = this.#generation
    try {
      const snapshot = await this.read()
      if (generation !== this.#generation) return
      const content = document.createDocumentFragment()
      const line = (parent: Node, text: string, tag = 'p'): void => {
        const el = document.createElement(tag); el.textContent = text; parent.appendChild(el)
      }
      line(content, 'Room messages and signalling', 'h3')
      for (const text of snapshot.room) line(content, text)
      line(content, 'Media from this device', 'h3')
      if (!snapshot.people.length) line(content, 'No other devices on this call yet.')
      for (const person of snapshot.people) {
        const section = document.createElement('section')
        line(section, person.name, 'h4')
        for (const { label, connection } of person.devices) {
          line(section, `${label} · ${connection.state}`)
          line(section, connection.route)
          line(section, connection.traffic)
          line(section, connection.video)
        }
        content.append(section)
      }
      line(content, 'Updates every two seconds while open. These are this device’s observations; another person may use a different route. Direct connections may run over a VPN. A server name does not verify its operator. STUN helps find addresses; it does not carry call media.')
      this.host.replaceChildren(content)
    } catch {
      if (generation === this.#generation) this.host.textContent = 'Connection details unavailable. Retrying…'
    } finally { this.#reading = false }
  }
}
