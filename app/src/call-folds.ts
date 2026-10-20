/**
 * The call's extra settings, folded until somebody asks for them.
 *
 * More was a `<details>` fold; it is a menu now (app/src/call-more.ts), shut
 * until it is opened, so there is nothing left to fold. The module stays
 * because the startup order is pinned around it (`ordinary-startup-entry.ts`
 * and its guard specs), and it still puts away a fold in an older page.
 */

const fold = document.getElementById('callExtras')
if (fold instanceof HTMLDetailsElement) fold.open = false

export {}
