/** Test-bundle instrumentation only. Every replacement is exact and guarded;
 * observers add no await, query, retry or caller-supplied callback. */
export function instrumentBrowserLinkOwnership(source: string): string {
  function replace(before: string, after: string): void {
    if (source.split(before).length !== 2) throw new Error('Browser Link diagnostic source drift')
    source = source.replace(before, after)
  }
  replace("  const held = navigator.locks.request(", "  __linkMark('ownership-request'); const held = navigator.locks.request(")
  replace("async lock => {\n    if (!lock", "async lock => {\n    __linkMark(lock ? 'callback-has-lock' : 'callback-no-lock'); if (!lock")
  replace("const done = () => { signal.removeEventListener", "const done = () => { __linkMark('waiting-release'); signal.removeEventListener")
  replace("resolve(async () => { done(); await held })", "resolve(async () => { __linkMark('release-called'); done(); await held; __linkMark('native-held-settled') })")
  replace("resume(account: string, relays?: string[]): Promise<PairedBox[]> {", "resume(account: string, relays?: string[]): Promise<PairedBox[]> { __linkMark('resume-enter')")
  replace("if (this.#opening) return this.#opening", "if (this.#opening) { __linkMark('resume-cached-opening'); return this.#opening }")
  replace("const opening = this.#open(account, relays, generation, signal)", "__linkMark('resume-fresh-opening'); const opening = this.#open(account, relays, generation, signal)")
  replace("void opening.finally(() => { if (this.#opening === opening) this.#opening = undefined })", "void opening.finally(() => { __linkMark('opening-finally'); if (this.#opening === opening) { this.#opening = undefined; __linkMark('opening-cleared') } })")
  replace("await this.#stopping; this.#current(generation)", "__linkMark('open-await-stopping'); await this.#stopping; __linkMark('open-stopping-settled'); this.#current(generation)")
  replace("release = await this.ownership(signal); this.#current(generation)", "__linkMark('open-await-ownership'); release = await this.ownership(signal); __linkMark('open-ownership-settled'); this.#current(generation)")
  replace("this.#engine = engine; this.#state = state; this.#release = release", "__linkMark('open-publish-engine'); this.#engine = engine; this.#state = state; this.#release = release")
  replace("} catch (error) {\n      await engine?.stop()", "} catch (error) {\n      __linkMark('open-caught'); await engine?.stop()")
  replace("stop(): Promise<void> {\n    ++this.#generation", "stop(): Promise<void> {\n    __linkMark('stop-enter'); ++this.#generation")
  replace("this.#stopping = this.#stopping.then(async () => {", "this.#stopping = this.#stopping.then(async () => { __linkMark('stop-task-enter')")
  replace("await opening?.catch(() => {})", "__linkMark('stop-await-opening'); await opening?.catch(() => {}); __linkMark('stop-opening-settled')")
  replace("try { await engine?.stop() }", "try { __linkMark('stop-await-engine'); await engine?.stop(); __linkMark('stop-engine-settled') }")
  replace("await this.#pending.catch(() => {})", "__linkMark('stop-await-pending'); await this.#pending.catch(() => {}); __linkMark('stop-pending-settled')")
  replace("if (state) wipeLinkState(state)\n        await release?.()", "if (state) wipeLinkState(state)\n        __linkMark('stop-await-release'); await release?.(); __linkMark('stop-release-settled')")
  return `const __linkEvents: string[] = []
const __linkPush = Array.prototype.push, __linkApply = Reflect.apply
Object.defineProperty(globalThis, '__vennelLinkOwnershipTrace', {value: __linkEvents})
function __linkMark(label: string): void {
  try { if (__linkEvents.length < 64) __linkApply(__linkPush, __linkEvents, [label]) } catch {}
}
` + source
}
