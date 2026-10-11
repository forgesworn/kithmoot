import { defineConfig, mergeConfig } from 'vite'
import app from '../app/vite.config.js'

// Disposable opt-in lab only. The production config proxies this path for
// preview, while the live MLS lab serves its gated WASM from the dev server.
export default mergeConfig(app, defineConfig({ server: {
  proxy: { '/__test-relay': { target: `ws://127.0.0.1:${Number(process.env.E2E_RELAY_PORT ?? 7892)}`, ws: true } },
} }))
