import type { AreaRect } from './share-area.js'

export {}
declare global {
  interface Window {
    kithmootDesktop?: {
      supportsShareArea?: boolean
      armShareArea(): Promise<boolean>
      shareAreaState(): Promise<AreaRect | null>
      shareAreaAction(action: string, value?: unknown): void
      onShareAreaState(listener: (state: AreaRect | null) => void): () => void
      setCallActive(active: boolean): void
      setUnread(count: number): void
      notify(content: { title: string; body: string; tag: string; roomId: string; silent: boolean }): void
      onOpenRoom(listener: (roomId: string) => void): () => void
    }
  }
}
