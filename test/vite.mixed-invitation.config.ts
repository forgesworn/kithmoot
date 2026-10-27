import { defineConfig } from 'vite'
import app from '../app/vite.config.js'
// The unmodified built Bark manifest explicitly permits localhost HTTP.
// Browsers treat localhost as a secure context. Runtime WSS retains TLS.
const base = app as any
export default defineConfig({ ...base, plugins: base.plugins.filter((p: any) => p?.name !== 'vite:basic-ssl'), server: {
  ...base.server, host: '127.0.0.1', port: 28445, strictPort: true,
  allowedHosts: ['link-lab.forgesworn.dev'],
  https: false,
} })
