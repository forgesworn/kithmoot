import type { StartLink } from './browser-link-types.js'
import type * as Binding from '../public/link-web/link_web.js'

let binding: Promise<typeof Binding> | undefined
const version = 'd363a30e5e0cae6628f0ed413d49ac68fba91817'
/** Self-hosted pinned WASM, loaded only after the person opens Bothy. */
export const startBrowserLink: StartLink = async config => {
  const module = await (binding ??= (async () => {
    const url = `${import.meta.env.BASE_URL}link-web/link_web.js?v=${version}`
    const loaded = await import(/* @vite-ignore */ url) as typeof Binding
    await loaded.default({ module_or_path: `${import.meta.env.BASE_URL}link-web/link_web_bg.wasm?v=${version}` })
    return loaded
  })().catch(error => { binding = undefined; throw error }))
  return module.LinkEngine.start(config)
}
