import type {Plugin} from 'vite'

/** Diagnostic builds only. Match each original source seam exactly once;
 * product source and every normal build remain uninstrumented. */
export function boardOpenDiagnosticPlugin(): Plugin {
  return {
    name: 'board-native-event-diagnostic-no-acceptance',
    enforce: 'pre',
    transform(source, id) {
      if (!id.split('?')[0]!.replaceAll('\\', '/').endsWith('/app/src/boards-panel.ts')) return
      const edits: readonly (readonly [string, string])[] = [
        ['  open(from: HTMLElement, context?: BoardContext, invitation?: string) {', '  open(from: HTMLElement, context?: BoardContext, invitation?: string) {\n    __boardNativeDiagnosticMark(\'panel-open-entry\')'],
        ["    if (!this.dialog.open) this.dialog.showModal()", "    __boardNativeDiagnosticMark('panel-open-before-modal')\n    if (!this.dialog.open) this.dialog.showModal()"],
        ["    } else {const button = this.root.getElementById('boardsSignIn'); if (button) button.hidden = true}", "    } else {const button = this.root.getElementById('boardsSignIn'); if (button) button.hidden = true}\n    __boardNativeDiagnosticMark('panel-open-return')"],
        ["    const doc = container.ownerDocument, frame = doc.createElement('iframe'), abort = new AbortController()", "    __boardNativeDiagnosticMark('panel-mount-entry')\n    const doc = container.ownerDocument, frame = doc.createElement('iframe'), abort = new AbortController()"],
        ['  private closeView(view?: BoardView) {\n    if (!view) return', "  private closeView(view?: BoardView) {\n    if (!view) return\n    __boardNativeDiagnosticMark('panel-close-view')"],
        ['    if (this.#view && this.#view.account !== session) {this.closeView(this.#view);', "    if (this.#view && this.#view.account !== session) {__boardNativeDiagnosticMark('panel-sync-account-change');this.closeView(this.#view);"],
        ['  reset(): Promise<void> {this.closeNavigation();', "  reset(): Promise<void> {__boardNativeDiagnosticMark('panel-reset-entry');this.closeNavigation();"],
      ]
      let code = source
      for (const [before, after] of edits) {
        if (code.split(before).length !== 2) throw new Error('Board diagnostic source seam is not unique')
        code = code.replace(before, after)
      }
      return {code: `function __boardNativeDiagnosticMark(kind: string): void {
        try {
          const mark = Object.getOwnPropertyDescriptor(window, '__boardOpenDiagnosticMark')?.value
          if (typeof mark === 'function') mark(kind)
        } catch { /* Diagnostic observation never replaces app results. */ }
      }\n` + code, map: null}
    },
  }
}
