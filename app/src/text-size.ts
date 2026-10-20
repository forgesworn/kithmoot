/**
 * How big the words are, on top of whatever the browser's own text size is.
 *
 * The same three choices the Android app offers, remembered on this device
 * and applied as a scale on the root font size. Every size in style.css is in
 * rem, so one number moves the whole page, and the browser's own setting still
 * counts because the scale is a percentage of it.
 *
 * Loaded as its own module from index.html rather than from main.ts, so the
 * choice is applied before the first paint of the room and reading it does
 * not wait for the rest of the app to load.
 */

export const TEXT_SIZES = { standard: '', large: '125%', huge: '150%' } as const
export type TextSize = keyof typeof TEXT_SIZES

const KEY = 'kithmoot.textSize'

function isTextSize(value: unknown): value is TextSize {
  return typeof value === 'string' && Object.hasOwn(TEXT_SIZES, value)
}

function saved(): TextSize {
  try {
    const value = localStorage.getItem(KEY)
    return isTextSize(value) ? value : 'standard'
  } catch {
    return 'standard'
  }
}

function apply(size: TextSize): void {
  document.documentElement.style.fontSize = TEXT_SIZES[size]
  document.documentElement.dataset.textSize = size
  for (const input of document.querySelectorAll<HTMLInputElement>('[data-text-size] input[type=radio]')) {
    input.checked = input.value === size
  }
}

apply(saved())

document.addEventListener('change', (event) => {
  const input = event.target
  if (!(input instanceof HTMLInputElement) || !input.closest('[data-text-size]') || !isTextSize(input.value)) return
  try { localStorage.setItem(KEY, input.value) } catch { /* private mode: the choice lasts this visit */ }
  apply(input.value)
})

// The markup may arrive after this module in a slow parse; tick the saved
// choice again once the document is complete.
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => apply(saved()), { once: true })
