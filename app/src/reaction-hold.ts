/** Hold a message to react; delegate so incoming messages can repaint the log. */
export function installReactionHold(log: HTMLElement): void {
  let hold: { pointer: number; x: number; y: number; scrollTop: number; id: string; author: string } | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let touch = false
  const cancel = (): void => { clearTimeout(timer); hold = undefined }
  log.addEventListener('pointerdown', event => {
    cancel()
    touch = event.pointerType === 'touch'
    if (!event.isPrimary || event.button !== 0) return
    const target = event.target as HTMLElement
    if (target.closest('a, button, input, textarea, audio, video')) return
    const bubble = target.closest('.reactableBubble')
    const row = bubble?.closest<HTMLElement>('[data-message-id]')
    if (!row) return
    hold = { pointer: event.pointerId, x: event.clientX, y: event.clientY, scrollTop: log.scrollTop, id: row.dataset.messageId!, author: row.dataset.messageAuthor! }
    timer = setTimeout(() => {
      if (!hold) return
      const current = Array.from(log.querySelectorAll<HTMLElement>('[data-message-id]'))
        .find(row => row.dataset.messageId === hold!.id && row.dataset.messageAuthor === hold!.author)
      const trigger = current?.querySelector<HTMLButtonElement>('.messageReact')
      cancel()
      if (!trigger) return
      window.getSelection()?.removeAllRanges()
      trigger.click()
    }, 450)
  })
  document.addEventListener('pointermove', event => {
    if (hold && event.pointerId === hold.pointer && Math.hypot(event.clientX - hold.x, event.clientY - hold.y) > 8) cancel()
  }, { passive: true })
  for (const event of ['pointerup', 'pointercancel']) document.addEventListener(event, cancel)
  log.addEventListener('scroll', () => {
    if (hold && Math.abs(log.scrollTop - hold.scrollTop) > 1) cancel()
  }, { passive: true })
  window.addEventListener('blur', cancel)
  log.addEventListener('contextmenu', event => {
    if (touch && (event.target as HTMLElement).closest('.reactableBubble') && !(event.target as HTMLElement).closest('a, button, audio, video')) event.preventDefault()
  })
}
