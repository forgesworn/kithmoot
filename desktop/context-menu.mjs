/**
 * The desktop window's right-click menu.
 *
 * Electron builds no context menu at all unless the app asks for one, so
 * without this a right-click inside KithMoot's window did nothing. This is
 * a pure template builder: it reads Chromium's `params` for the
 * `context-menu` event and returns a plain array of menu item options,
 * built entirely from `role` strings bar the link and spelling items, which
 * need callbacks the caller supplies. Nothing here touches `electron`, so
 * it is testable with `node:test` alone - `main.mjs` is the only place that
 * turns the template into a real `Menu` and pops it up.
 *
 * Disabled or empty sections are left out rather than shown greyed out:
 * plain text carries nothing to cut or paste, so a menu offering it anyway
 * is noise. An empty template means the caller should show nothing at all.
 */

/**
 * @param {Electron.ContextMenuParams} params
 * @param {{ replaceMisspelling: (word: string) => void, copyLink: (url: string) => void, openLink: (url: string) => void }} actions
 * @returns {Electron.MenuItemConstructorOptions[]}
 */
export function buildContextMenuTemplate(params, actions) {
  const template = []

  if (params.dictionarySuggestions?.length) {
    for (const word of params.dictionarySuggestions) {
      template.push({ label: word, click: () => actions.replaceMisspelling(word) })
    }
  }

  const edit = []
  if (params.editFlags?.canCut) edit.push({ role: 'cut' })
  if (params.editFlags?.canCopy) edit.push({ role: 'copy' })
  if (params.isEditable && params.editFlags?.canPaste) {
    edit.push({ role: 'paste' }, { role: 'pasteAndMatchStyle', label: 'Paste and Match Style' })
  }
  if (params.editFlags?.canSelectAll) edit.push({ role: 'selectAll' })
  if (edit.length) {
    if (template.length) template.push({ type: 'separator' })
    template.push(...edit)
  }

  const linkable = isHttpUrl(params.linkURL)
  if (linkable) {
    if (template.length) template.push({ type: 'separator' })
    template.push(
      { label: 'Copy Link', click: () => actions.copyLink(params.linkURL) },
      { label: 'Open Link', click: () => actions.openLink(params.linkURL) },
    )
  }

  return template
}

function isHttpUrl(value) {
  if (!value) return false
  try { return ['http:', 'https:'].includes(new URL(value).protocol) }
  catch { return false }
}
