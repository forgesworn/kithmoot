import { claimKithmootNode, parseKithmootNodePairingLink, queryKithmootNodeStatus, queryNodeCloseOperation } from '../../src/kithmoot-node.js'
import type { ParticipantIdentity } from '../../src/identity.js'
import type { DeviceStore } from './device-store.js'
import { confirmAction } from './confirm-action.js'
import { loadPairedNode, storePairedNode, unpairNode, nodeCloseReferences, forgetNodeCloseReference } from './node-rooms.js'

/** Owner actions are always explicit. Opening a pairing link only fills the
 * private form; no request is made until Pair and the target confirmation. */
export class NodeSettings {
  private revision = 0
  private controller?: AbortController
  private busy = false
  constructor(private readonly options: {
    store: DeviceStore
    owner: () => ParticipantIdentity | undefined
    changed: () => void
  }) {
    this.element<HTMLButtonElement>('nodePair').addEventListener('click', () => void this.pair())
    this.element<HTMLButtonElement>('nodeCheck').addEventListener('click', () => void this.check())
    this.element<HTMLButtonElement>('nodeUnpair').addEventListener('click', () => void this.remove())
  }
  private element<T extends HTMLElement = HTMLElement>(id: string): T { return document.getElementById(id) as T }
  cancel(): void { this.revision++; this.controller?.abort(); this.controller = undefined; this.busy = false }
  arrival(fragment: string): void {
    this.element<HTMLInputElement>('nodePairingInput').value = fragment
    this.render()
    this.message('Check the node address before pairing. A pairing link lasts six minutes.')
  }
  summary(): string {
    const owner = this.options.owner(), pair = owner && loadPairedNode(this.options.store, owner.pubkey)
    return pair ? new URL(pair.origin).hostname : 'Host rooms and calls on your node'
  }
  render(): void {
    this.cancel()
    const owner = this.options.owner(), pair = owner && loadPairedNode(this.options.store, owner.pubkey)
    this.element('nodeUnpaired').hidden = !!pair
    this.element('nodePaired').hidden = !pair
    this.element<HTMLButtonElement>('nodePair').disabled = !owner
    this.element<HTMLButtonElement>('nodeCheck').disabled = false
    this.element('nodeAccountNote').textContent = owner ? 'Pairing is kept for this account on this device.' : 'Sign in to your account to pair a node. Guests can ask to join its rooms without an account.'
    this.element('nodeHost').textContent = pair ? new URL(pair.origin).hostname : ''
    this.element('nodeFacts').textContent = pair ? 'Paired on this device. Choose Check status to contact your node.' : ''
    this.message('')
    this.renderOperations()
  }
  private message(text: string): void { this.element('nodePairingStatus').textContent = text }
  private async pair(): Promise<void> {
    if (this.busy) return
    const owner = this.options.owner(); if (!owner) { this.render(); return }
    const revision = this.revision, current = () => this.revision === revision && this.options.owner()?.pubkey === owner.pubkey
    const input = this.element<HTMLInputElement>('nodePairingInput')
    this.busy = true; this.element<HTMLButtonElement>('nodePair').disabled = true
    try {
      const value = input.value.trim(), fragment = value.startsWith('#') ? value : new URL(value).hash
      const link = parseKithmootNodePairingLink(fragment)
      if (!await confirmAction({ title: 'Pair your KithMoot node?', message: `Pair this account with ${new URL(link.origin).hostname}? It will host rooms you choose to create there and see connecting devices’ IP addresses.`, confirmLabel: 'Pair node', isCurrent: current })) return
      if (!current()) return
      this.controller = new AbortController(); this.message('Pairing…')
      const pair = await claimKithmootNode(link, owner, { allowed: current, signal: this.controller.signal })
      if (!current()) return
      storePairedNode(this.options.store, owner.pubkey, pair); input.value = ''
      this.render(); this.options.changed(); this.message('Node paired. Existing rooms keep their current host.')
    } catch { if (current()) this.message('Pairing failed. Check your connection and copy a fresh pairing link from your node.') }
    finally { if (current()) { this.busy = false; this.element<HTMLButtonElement>('nodePair').disabled = false } }
  }
  private async check(): Promise<void> {
    if (this.busy) return
    const owner = this.options.owner(), pair = owner && loadPairedNode(this.options.store, owner.pubkey); if (!owner || !pair) return
    const revision = this.revision, current = () => this.revision === revision && this.options.owner()?.pubkey === owner.pubkey
    this.busy = true; this.controller = new AbortController(); this.element<HTMLButtonElement>('nodeCheck').disabled = true
    this.message('Checking your node…')
    try {
      const status = await queryKithmootNodeStatus(pair, owner, { signal: this.controller.signal, allowed: current })
      if (!current()) return
      const usage = status.storeBytes === undefined ? 'Storage usage unknown' : `${(status.storeBytes / 1048576).toFixed(1)} MB stored`
      this.element('nodeFacts').textContent = `${status.ready ? 'Ready' : 'Needs attention'} · Version ${status.version} · ${status.rooms} rooms · ${status.devices} devices · ${usage}. Calls ${status.turnReady ? 'ready' : 'unavailable'}; messages ${status.relayReady ? 'ready' : 'unavailable'}.`
      this.message('Status checked just now.')
    } catch { if (current()) { this.element('nodeFacts').textContent = 'Status unknown. Your node could not be reached or refused this account.'; this.message('Check the node and try again. Hosted rooms do not switch to another server.') } }
    finally { if (current()) { this.busy = false; this.element<HTMLButtonElement>('nodeCheck').disabled = false } }
  }
  private async remove(): Promise<void> {
    if (this.busy) return
    const owner = this.options.owner(); if (!owner) return
    const revision = this.revision, current = () => this.revision === revision && this.options.owner()?.pubkey === owner.pubkey
    if (!await confirmAction({ title: 'Unpair this device?', message: 'This removes the pairing from this device. It leaves hosted rooms running and does not change the node’s owner. Use a fresh pairing link to reconnect this account.', confirmLabel: 'Unpair', danger: true, isCurrent: current }) || !current()) return
    unpairNode(this.options.store, owner.pubkey); this.render(); this.options.changed(); this.message('Unpaired on this device.')
  }
  private renderOperations(): void {
    const list = this.element('nodeOperations'); list.replaceChildren()
    const owner = this.options.owner(); if (!owner) return
    for (const reference of nodeCloseReferences(this.options.store, owner.pubkey)) {
      const row = document.createElement('div'); row.className = 'relayFacts'
      const text = document.createElement('p'); text.className = 'relayFact'; text.textContent = `Room closure on ${new URL(reference.node.origin).hostname}: completion not yet checked.`
      const check = document.createElement('button'); check.type = 'button'; check.textContent = 'Check closure'
      check.addEventListener('click', async () => {
        check.disabled = true
        const revision = this.revision, current = () => revision === this.revision && this.options.owner()?.pubkey === owner.pubkey
        try {
          const result = await queryNodeCloseOperation(reference.node, reference.operation, owner, { allowed: current })
          if (!current()) return
          text.textContent = result.phase === 'done' ? 'Node confirmed: room access revoked and stored messages purged.' : 'Closure is still in progress. Check again shortly.'
          if (result.phase === 'done') { forgetNodeCloseReference(this.options.store, owner.pubkey, reference.operation); check.remove() }
        } catch { if (current()) text.textContent = 'Completion unknown. The node could not be reached or no longer holds a completion receipt.' }
        finally { if (current()) check.disabled = false }
      })
      row.append(text, check); list.append(row)
    }
  }
}
