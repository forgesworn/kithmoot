import type { APIResponse, BrowserContext, Route } from '@playwright/test'

const TEST_BLOSSOM_ORIGIN = 'http://127.0.0.1:7777'

/** Forward an intercepted public-origin Blossom request to the acceptance
 * companion without asking Playwright to materialise its body. WebKit keeps a
 * streamed Blob opaque to `postDataBuffer()`, but `route.fetch()` can carry
 * that same request through to a real HTTP server. */
export async function fetchFromTestBlossom(route: Route, publicOrigin: string): Promise<APIResponse> {
  const request = route.request()
  const url = new URL(request.url())
  return route.fetch({
    url: TEST_BLOSSOM_ORIGIN + url.pathname + url.search,
    headers: { ...request.headers(), origin: publicOrigin },
  })
}

/** Route one browser context's uploads and downloads through the shared
 * test-only Blossom store while keeping the descriptor's URL on the origin
 * the app was actually opened from. */
export async function routeTestBlossom(context: BrowserContext, publicOrigin: string): Promise<void> {
  await context.route(
    (url) => url.origin === publicOrigin && (url.pathname === '/upload' || url.pathname.startsWith('/blossom/')),
    async (route) => route.fulfill({ response: await fetchFromTestBlossom(route, publicOrigin) }),
  )
}
