import type { AreaCheck, AreaRect } from './share-area.js'
import type { RedactionState } from './redaction-geometry.js'

export {}
declare global {
  interface Window {
    kithmootDesktop?: {
      supportsShareArea?: boolean
      shareAreaMode?: 'frame' | 'preview' | null
      armShareArea(): Promise<boolean>
      shareAreaState(): Promise<AreaRect | null>
      /** Whether the frame sits wholly on one screen, and why the last request to share was refused. */
      shareAreaCheck?(): Promise<AreaCheck | null>
      onShareAreaCheck?(listener: (check: AreaCheck | null) => void): () => void
      /** macOS's Screen Recording status for the app; 'granted' elsewhere. */
      screenAccess?(): Promise<string>
      shareAreaAction(action: string, value?: unknown): void
      onShareAreaState(listener: (state: AreaRect | null) => void): () => void
      supportsRedaction?: boolean
      redactionBegin?(): Promise<RedactionState | null>
      redactionState?(): Promise<RedactionState | null>
      redactionAction?(id: string | null, action: string, value?: unknown): void
      onRedactionState?(listener: (state: RedactionState | null) => void): () => void
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
