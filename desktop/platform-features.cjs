function linuxDisplayBackend(env = process.env) {
  const session = String(env.XDG_SESSION_TYPE || '').toLowerCase()
  if (session === 'wayland') return 'wayland'
  if (session === 'x11') return 'x11'
  if (env.WAYLAND_DISPLAY && !env.DISPLAY) return 'wayland'
  return 'x11'
}

function supportsShareArea(platform = process.platform, env = process.env) {
  if (platform === 'darwin' || platform === 'win32') return true
  return platform === 'linux' && linuxDisplayBackend(env) === 'x11'
}

const SHARE_AREA_SWITCH = '--kithmoot-share-area'

module.exports = { SHARE_AREA_SWITCH, linuxDisplayBackend, supportsShareArea }
