import type { AreaRect } from './share-area.js'

export {}
declare global {
  interface Window {
    kithmootDesktop?: {
      supportsShareArea?: boolean
      shareAreaMode?: 'frame' | 'preview' | null
      armShareArea(): Promise<boolean>
      shareAreaState(): Promise<AreaRect | null>
      shareAreaAction(action: string, value?: unknown): void
      onShareAreaState(listener: (state: AreaRect | null) => void): () => void
      setCallActive(active: boolean): void
      updateState(): Promise<{ phase: 'disabled' | 'idle' | 'checking' | 'downloading' | 'ready' | 'error'; version?: string; message?: string }>
      installUpdate(): Promise<boolean>
      onUpdateState(listener: (state: { phase: string; version?: string; message?: string }) => void): () => void
      setUnread(count: number): void
      notify(content: { title: string; body: string; tag: string; roomId: string; silent: boolean }): void
      onOpenRoom(listener: (roomId: string) => void): () => void
    }
  }
}
