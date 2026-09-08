/** A short flourish for the reaction the person just chose. */
export function showReactionFeedback(anchor: HTMLElement, emoji: string): void {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return
  const bounds = anchor.getBoundingClientRect()
  const sparkle = document.createElement('span')
  sparkle.className = 'reactionFeedback'
  sparkle.textContent = emoji
  sparkle.setAttribute('aria-hidden', 'true')
  sparkle.popover = 'manual'
  sparkle.style.left = `${Math.max(8, Math.min(bounds.right - 40, innerWidth - 56))}px`
  sparkle.style.top = `${Math.max(32, Math.min(bounds.top, innerHeight - 56))}px`
  document.body.append(sparkle)
  sparkle.showPopover()
  const animation = sparkle.animate([
    { transform: 'translateY(8px) scale(.5) rotate(-12deg)', opacity: 0 },
    { transform: 'translateY(-8px) scale(1.25) rotate(8deg)', opacity: 1, offset: .3 },
    { transform: 'translateY(-12px) scale(1) rotate(0)', opacity: 1, offset: .65 },
    { transform: 'translateY(-28px) scale(.85)', opacity: 0 },
  ], { duration: 650, easing: 'ease-out' })
  void animation.finished.then(() => sparkle.remove(), () => sparkle.remove())
}
