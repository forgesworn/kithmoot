/** A transient effect after cleanup. Holds no room name, key, content or snapshot. */
export function showDestructEffect(): void {
  document.getElementById('destructEffect')?.remove()
  const effect = document.createElement('div')
  effect.id = 'destructEffect'
  effect.className = 'destructEffect'
  effect.setAttribute('role', 'status')
  const art = document.createElement('div')
  art.className = 'destructArt'
  art.setAttribute('aria-hidden', 'true')
  const ring = document.createElement('span')
  ring.className = 'destructRing'
  art.append(ring)
  for (let i = 0; i < 32; i++) {
    const spark = document.createElement('i')
    spark.style.setProperty('--angle', `${i * 137.508}deg`)
    spark.style.setProperty('--distance', `${70 + i % 5 * 24}px`)
    spark.style.setProperty('--delay', `${i % 4 * 35}ms`)
    art.append(spark)
  }
  const words = document.createElement('div')
  words.className = 'destructWords'
  const title = document.createElement('strong')
  title.textContent = 'Room self-destructed'
  const detail = document.createElement('span')
  detail.textContent = 'The room is gone from this device'
  words.append(title, detail)
  effect.append(art, words)
  document.body.append(effect)
  setTimeout(() => effect.remove(), 3200)
}
