import { createReadStream } from 'node:fs'
import { copyFile, mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build as esbuild } from 'esbuild'
import { defineConfig, type Plugin } from 'vite'
import basicSsl from '@vitejs/plugin-basic-ssl'
import { VitePWA } from 'vite-plugin-pwa'

const here = dirname(fileURLToPath(import.meta.url))
const BASE = '/j/'

/**
 * The MediaPipe WASM runtime, served from our own origin.
 *
 * Every MediaPipe example points `FilesetResolver` at Google's CDN. In an
 * app whose whole claim is that no operator can see you, that would mean
 * enabling background blur announces your IP address and the fact that you
 * are about to join a call to a third party. So the runtime is copied out of
 * `node_modules` at build time and served from here instead.
 *
 * Copied in `writeBundle` rather than emitted through rollup: it is 11.7MB
 * and there is no reason to route that through the bundler's memory, and
 * landing it after the service worker has been generated keeps it out of the
 * precache, which is the other thing nobody wants 11.7MB of.
 */
function mediapipeRuntime(): Plugin {
  // Both variants. FilesetResolver probes for WASM SIMD and asks for the
  // `nosimd` pair when the probe fails - a browser without SIMD, or a
  // Content-Security-Policy that blocks the probe's little compile. Shipping
  // only the SIMD pair turned that into a 404 and a dead segmenter in
  // production, which is how it went unnoticed: the effect fell back to
  // passthrough exactly as designed, and nothing red runs in CI against the
  // deployed origin.
  const files = [
    'vision_wasm_internal.js',
    'vision_wasm_internal.wasm',
    'vision_wasm_nosimd_internal.js',
    'vision_wasm_nosimd_internal.wasm',
  ]
  const from = resolve(here, '../node_modules/@mediapipe/tasks-vision/wasm')
  return {
    name: 'kithmoot-mediapipe-runtime',
    apply: () => true,
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const name = req.url?.split('?')[0]?.replace(`${BASE}mediapipe/`, '')
        if (!req.url?.startsWith(`${BASE}mediapipe/`) || !name || !files.includes(name)) return next()
        res.setHeader('content-type', name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript')
        createReadStream(join(from, name)).pipe(res)
      })
    },
    async writeBundle(options) {
      const out = join(options.dir ?? resolve(here, 'dist'), 'mediapipe')
      await mkdir(out, { recursive: true })
      for (const name of files) await copyFile(join(from, name), join(out, name))
    },
  }
}

/**
 * The voice-masking `AudioWorklet`, bundled on its own.
 *
 * An `AudioWorkletGlobalScope` has no module loader, so the script handed to
 * `addModule` has to be one file with no imports in it. Vite's own worker
 * handling produces an ES module with imports in dev, which does not load
 * there. Thirty lines of esbuild produce the same self-contained IIFE in dev
 * and in a production build, which is worth more than the thirty lines.
 */
function audioWorklet(): Plugin {
  const entry = resolve(here, 'src/voice-worklet.ts')
  const bundle = async (): Promise<string> => {
    const result = await esbuild({
      entryPoints: [entry],
      bundle: true,
      format: 'iife',
      target: 'es2022',
      write: false,
      minify: true,
      legalComments: 'none',
    })
    return result.outputFiles?.[0]?.text ?? ''
  }
  return {
    name: 'kithmoot-audio-worklet',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.split('?')[0] !== `${BASE}voice-worklet.js`) return next()
        bundle().then(
          (code) => {
            res.setHeader('content-type', 'text/javascript')
            res.end(code)
          },
          (err: Error) => {
            res.statusCode = 500
            res.end(`/* ${err.message} */`)
          },
        )
      })
      // A change to the DSP has to invalidate the worklet, which the module
      // graph knows nothing about because nothing imports it.
      server.watcher.add([entry, resolve(here, '../src/voice-effects.ts')])
    },
    async generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'voice-worklet.js', source: await bundle() })
    },
  }
}

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
  base: BASE,
  build: {
    // Written outside app/ so `dist/` at the repo root is unambiguous
    // between the library build (tsc, ./dist) and this one - callers
    // deploying the app want app/dist, not the library's.
    outDir: resolve(here, 'dist'),
    emptyOutDir: true,
  },
  plugins: [
    mediapipeRuntime(),
    audioWorklet(),
    // getUserMedia and getDisplayMedia both require a secure context. A
    // phone reaching the laptop over its LAN IP is not one without this -
    // and the phone is the device the whole app exists to prove works.
    basicSsl(),
    VitePWA({
      registerType: 'autoUpdate',
      // The MediaPipe runtime is 11.7MB of WASM plus 155KB of glue, and it
      // is fetched only if somebody turns an effect on. Precaching it would
      // make every first visit pay, in the background, for a feature most
      // visits never use - which is the exact thing the lazy load exists to
      // avoid. Both halves are excluded together, because precaching one
      // half of a pair that is useless apart is the worst of both.
      workbox: { globIgnores: ['**/mediapipe/**', '**/vision_bundle-*.js'] },
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
