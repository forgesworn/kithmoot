export {}
declare global {
  interface Window {
    kithmootDesktop?: { setCallActive(active: boolean): void; setUnread(count: number): void; notify(content: { title: string; body: string; tag: string; roomId: string; silent: boolean }): void; onOpenRoom(listener: (roomId: string) => void): () => void }
  }
}
