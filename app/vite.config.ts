import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import basicSsl from '@vitejs/plugin-basic-ssl'
import { VitePWA } from 'vite-plugin-pwa'

const here = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  // Resolved to an absolute path rather than the string 'app', so the
  // config behaves the same whether Vite is invoked from the repo root
  // (`npm run dev`) or from inside app/ directly.
  root: here,
  // The app is published under https://kithmoot.forgesworn.dev/j/, not at the
  // root - the root is the marketing page. A join link carries a 32-byte
  // secret plus relay hints in its fragment, so every character in the path
  // costs QR density; `/j` is the shortest path that still leaves room at the
  // root for something else. Setting this rewrites the asset URLs, the
  // manifest and the service worker's scope together - and the scope matters
  // as much as the assets, because a service worker registered at `/` would
  // otherwise answer navigations to the marketing page out of its own cache.
  base: '/j/',
  build: {
    // Written outside app/ so `dist/` at the repo root is unambiguous
    // between the library build (tsc, ./dist) and this one - callers
    // deploying the app want app/dist, not the library's.
    outDir: resolve(here, 'dist'),
    emptyOutDir: true,
  },
  plugins: [
    // getUserMedia and getDisplayMedia both require a secure context. A
    // phone reaching the laptop over its LAN IP is not one without this -
    // and the phone is the device the whole app exists to prove works.
    basicSsl(),
    VitePWA({
      registerType: 'autoUpdate',
      // Serves a real manifest and service worker under `npm run demo` too,
      // not only after a production build - otherwise the manifest link in
      // index.html 404s in dev and the browser logs a spurious parse error.
      devOptions: { enabled: true, type: 'module' },
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'KithMoot',
        short_name: 'KithMoot',
        description: 'A town hall nobody owns.',
        start_url: '.',
        display: 'standalone',
        background_color: '#101114',
        theme_color: '#101114',
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'maskable-icon-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
    }),
  ],
  server: {
    host: true,
    fs: {
      // The app imports the library straight from source (../src/index.ts)
      // rather than a built package, which sits outside app/ - Vite's
      // default file-serving guard only allows the project root and below.
      allow: [resolve(here, '..')],
    },
  },
})
