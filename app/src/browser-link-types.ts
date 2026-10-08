/** The browser binding's host contract. The generated declaration is checked
 * against this at build time; request policy belongs to the Rust engine. */
export interface LinkRoute {
  routeId: string
  card: Uint8Array
  pairedRouteSecret: Uint8Array
  cardSerial: bigint
  cardVerifiedAt: bigint
}
export interface LinkConfig { transportSeed: Uint8Array; relayUrls: string[]; routes: LinkRoute[] }
export interface LinkPairing { routeId: string; serverCard: Uint8Array; pairingSecret: Uint8Array; expiresAt: number }
export interface LinkPath { status: string; relay: string | null; direct: string | null; cause: string }
export interface LinkRequest { routeId: string; method: 'GET' | 'POST' | 'PUT' | 'DELETE'; path: string; authorization: string; body: Uint8Array }
export interface LinkResponse { status: number; body: Uint8Array; witnessRefused: boolean; path: LinkPath }
export interface LinkListener { onOpen?: () => void; onText?: (text: string) => void; onClosed?: (reason: string) => void }
export interface LinkSocket { sendText(text: string): void; disconnect(): void; path(): LinkPath }
export interface LinkEngine {
  pairRoute(bundle: LinkPairing): Promise<LinkRoute>
  request(request: LinkRequest): Promise<LinkResponse>
  openSocket(url: string, routeId: string, listener: LinkListener): Promise<LinkSocket>
  removeRoute(routeId: string): Promise<void>
  retireRoute(routeId: string): Promise<void>
  finalizeRoute(routeId: string): Promise<void>
  stop(): Promise<void>
}
export type StartLink = (config: LinkConfig) => Promise<LinkEngine>
