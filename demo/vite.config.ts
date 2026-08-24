import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import basicSsl from '@vitejs/plugin-basic-ssl'

const here = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  // Resolved to an absolute path rather than the string 'demo', so the
  // config behaves the same whether Vite is invoked from the repo root
  // (`npm run demo`) or from inside demo/ directly.
  root: here,
  plugins: [
    // getUserMedia and getDisplayMedia both require a secure context. A
    // phone reaching the laptop over its LAN IP is not one without this -
    // and the phone is the device the whole demo exists to prove.
    basicSsl(),
  ],
  server: {
    host: true,
    fs: {
      // The demo imports the library straight from source (../src/index.ts)
      // rather than a built package, which sits outside demo/ - Vite's
      // default file-serving guard only allows the project root and below.
      allow: [resolve(here, '..')],
    },
  },
})
