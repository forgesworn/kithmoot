import { icon } from './icons.js'

let fields = 0

/**
 * An eye button beside a secret field, such as a call relay password, a file
 * key or a pairing code. Pressing it shows what is in the field as plain text,
 * and pressing it again hides it.
 *
 * The button keeps one name and says whether it is pressed, so a screen reader
 * hears "Show relay password, toggle button, pressed" rather than a name that
 * changes under it. A field that sits inside its label is moved to just after
 * the label and tied back to it with `for`: a button inside a label would be
 * read as part of the field's name.
 *
 * Calling it again for the same field returns the button it already has.
 */
export function addReveal(input: HTMLInputElement, what: string): HTMLButtonElement {
  const held = input.parentElement?.classList.contains('reveal')
    ? input.parentElement.querySelector<HTMLButtonElement>(':scope > .revealToggle')
    : null
  if (held) return held
  const doc = input.ownerDocument
  const wrap = doc.createElement('span')
  wrap.className = 'reveal'
  const label = input.closest('label')
  if (label) {
    if (!input.id) input.id = `revealField${++fields}`
    label.htmlFor = input.id
    label.after(wrap)
  } else {
    input.replaceWith(wrap)
  }
  const button = doc.createElement('button')
  button.type = 'button'
  button.className = 'revealToggle'
  button.setAttribute('aria-label', `Show ${what}`)
  const sync = (): void => {
    const shown = input.type === 'text'
    button.setAttribute('aria-pressed', String(shown))
    button.title = `${shown ? 'Hide' : 'Show'} ${what}`
    button.replaceChildren(icon(shown ? 'eyeOff' : 'eye', doc))
  }
  button.addEventListener('click', () => {
    input.type = input.type === 'password' ? 'text' : 'password'
    sync()
    input.focus()
  })
  // Shown as text, a secret is not to be corrected, capitalised or offered to
  // a spellchecker.
  input.spellcheck = false
  input.setAttribute('autocapitalize', 'off')
  input.setAttribute('autocorrect', 'off')
  wrap.append(input, button)
  sync()
  return button
}
