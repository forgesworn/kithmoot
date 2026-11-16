import './metadata-panel.css'

export interface MetadataSnapshot {
  identity?: string
  relays: { url: string; state: string; authentication?: string }[]
  storage: string
  calls: { state: string; route: string; sent: number; received: number }[]
  addresses: string[]
  profiles: boolean
}

/** Only the address of the person opening this view is looked up, and only
 * after the button explains the additional disclosure. Nothing is stored. */
export class MetadataPanel {
  #generation = 0
  #busy = false
  constructor(readonly host: HTMLElement, readonly read: () => Promise<MetadataSnapshot>, readonly back: () => void) {
    host.innerHTML = `<div class="settingsBar"><button type="button" class="barBtn" data-meta-back aria-label="Back to Chats"><svg class="i" aria-hidden="true"><use href="#i-back"/></svg></button><h2 tabindex="-1">Metadata</h2></div>
      <p>Encryption protects content. Metadata is the information around it: who connects, from where, when and how much. It can reveal routines and relationships even when messages stay unreadable.</p>
      <p class="note">This view stays on your device. It describes known connections and possible disclosures; it cannot inspect a service’s logs or prove what it retains.</p>
      <button type="button" data-meta-refresh>Refresh connections</button><div data-meta-status role="status"></div>
      <div data-meta-details></div>
      <section><h3>Your public IP and approximate location</h3><p data-meta-address>No public address observed in this call yet. A VPN or proxy can make the address seen by different services differ.</p>
      <p>Relays and websites normally see the public IP used to connect to them. It can identify an internet provider and an approximate area, and help link activity across services. An IP lookup cannot reliably reveal your exact home or street address.</p>
      <p class="note">The button below contacts ipwho.is. That service will receive your connection IP and learn that you requested a lookup. No device location permission is requested. The result is kept only while this page is open.</p>
      <button type="button" data-meta-lookup>Look up my IP and approximate location</button><p data-meta-location role="status"></p></section>
      <section><h3>Browser information</h3><dl data-meta-browser></dl><p>Websites can receive browser headers. Scripts can also read language, time zone and screen size. Combining small details can help recognise a browser. This does not mean each relay receives all of these details.</p></section>
      <section><h3>Files you share</h3><p>KithMoot cleans supported files locally before encrypting or uploading them. Hidden camera, location, author and editing metadata can otherwise travel inside a file, even when the transfer is encrypted. Formats that cannot be cleaned are held unsent.</p><p>Cleaning removes common file tags; it cannot guarantee anonymity. Some information inside encoded video or sound may remain. It does not hide faces, spoken names, text, document contents or a revealing file name. Recipients can keep and forward what you share.</p></section>`
    host.querySelector('[data-meta-back]')!.addEventListener('click', back)
    host.querySelector('[data-meta-refresh]')!.addEventListener('click', () => void this.refresh())
    host.querySelector('[data-meta-lookup]')!.addEventListener('click', () => void this.lookup())
  }

  async refresh(): Promise<void> {
    const generation = ++this.#generation
    const status = this.host.querySelector<HTMLElement>('[data-meta-status]')!
    status.textContent = 'Reading this device’s connections…'
    try {
      const snapshot = await this.read()
      if (generation !== this.#generation || this.host.hidden) return
      const details = this.host.querySelector('[data-meta-details]')!
      details.replaceChildren()
      const section = (heading: string, value: string, explanation: string) => {
        const node = document.createElement('section'), title = document.createElement('h3'), text = document.createElement('p'), why = document.createElement('p')
        title.textContent = heading; text.textContent = value; why.textContent = explanation
        text.className = 'metadataValue'; node.append(title, text, why); details.append(node)
      }
      section('Your identity', snapshot.identity ?? 'Using a room identity without a signed-in public account.', 'Room members see your room name and identity. Public Nostr profile activity and relay authentication can reveal your public account to the relevant relays. Reusing an identity can link activity across rooms and services; encrypted room traffic does not automatically reveal your account to every relay.')
      section('Nostr relays', snapshot.relays.length ? snapshot.relays.map(r => `${r.url} · ${r.state}${r.authentication === 'authenticated' ? ' · authenticated as your account' : ''}`).join('\n') : 'No configured Nostr relays in this view.', 'A contacted relay sees the connecting IP, connection times, subscription filters and the outer events it carries. Encrypted payloads stay encrypted. Timing, volume, reused keys and public events can still help correlate activity. Listed relays may be idle; configured does not mean connected.')
      section('File storage', snapshot.storage, 'The storage operator sees your upload/download IP, timing and encrypted blob size. Room file encryption keeps the file contents inside the envelope. Authorisation and public announcements may expose additional identifiers depending on the storage route. Encryption does not hide traffic patterns.')
      section('Audio and video connections', snapshot.calls.length ? snapshot.calls.map((c, i) => `Connection ${i + 1}: ${c.state} · ${c.route} · sent ${c.sent} bytes · received ${c.received} bytes`).join('\n') : 'No peer connections available to inspect on this device.', 'Direct connections can expose network addresses to the other end. STUN learns the IP used to ask for an address; TURN operators see connection endpoints, timing and volume while relaying encrypted media. A linked device or a volunteer forwarder can be the other end: this view does not assume every connection is a direct link to a person.')
      section('External profile requests', snapshot.profiles ? 'Profile lookups are enabled.' : 'Automatic profile lookups are disabled.', 'Fetching a profile picture contacts its image host. NIP-05 checks contact the claimed domain. Those services can learn your connection IP and what you requested. Turning lookups off reduces these contacts; it does not undo earlier requests.')
      this.host.querySelector('[data-meta-address]')!.textContent = snapshot.addresses.length ? `Public addresses observed while setting up calls on this device: ${snapshot.addresses.join(', ')}. These may differ from the address used for web requests.` : 'No public address observed in this call yet. A VPN or proxy can make the address seen by different services differ.'
      const browser = this.host.querySelector('[data-meta-browser]')!
      browser.replaceChildren()
      for (const [name, value] of [['Browser', navigator.userAgent], ['Language', navigator.language], ['Time zone', Intl.DateTimeFormat().resolvedOptions().timeZone], ['Screen', `${screen.width} × ${screen.height} · scale ${devicePixelRatio}`], ['Web host', location.host]]) {
        const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = name!; dd.textContent = value!; browser.append(dt, dd)
      }
      status.textContent = `Read at ${new Date().toLocaleTimeString()}. Values are local observations, not a complete network capture.`
    } catch { if (generation === this.#generation) status.textContent = 'Connection details could not be read. Try refreshing.' }
  }

  hide(): void { this.#generation++ }

  private async lookup(): Promise<void> {
    if (this.#busy) return
    this.#busy = true
    const button = this.host.querySelector<HTMLButtonElement>('[data-meta-lookup]')!, line = this.host.querySelector('[data-meta-location]')!
    button.disabled = true; line.textContent = 'Asking ipwho.is…'
    try {
      const response = await fetch('https://ipwho.is/?fields=success,ip,city,region,country,connection.isp', { credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', signal: AbortSignal.timeout(10_000) })
      if (!response.ok) throw new Error()
      const data = await response.json()
      if (data.success !== true || typeof data.ip !== 'string' || data.ip.length > 64) throw new Error()
      const field = (value: unknown): string => typeof value === 'string' ? value.slice(0, 200) : ''
      line.textContent = `${field(data.ip)} · approximate area: ${[data.city, data.region, data.country].map(field).filter(Boolean).join(', ') || 'unknown'} · provider: ${field(data.connection?.isp) || 'unknown'}. This is not a verified physical address.`
    } catch { line.textContent = 'Lookup unavailable. No location could be established. Your call and messages keep working.' }
    finally { button.disabled = false; this.#busy = false }
  }
}
