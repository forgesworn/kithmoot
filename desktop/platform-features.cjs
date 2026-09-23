function linuxDisplayBackend(env = process.env) {
  const session = String(env.XDG_SESSION_TYPE || '').toLowerCase()
  if (session === 'wayland') return 'wayland'
  if (session === 'x11') return 'x11'
  if (env.WAYLAND_DISPLAY && !env.DISPLAY) return 'wayland'
  return 'x11'
}

/**
 * 'frame' floats a positioned crop frame over the screen. Wayland forbids a
 * client placing its own window, so there the person draws the rectangle on
 * a preview of the monitor the portal gave us instead.
 */
function shareAreaMode(platform = process.platform, env = process.env) {
  if (platform === 'darwin' || platform === 'win32') return 'frame'
  if (platform !== 'linux') return null
  return linuxDisplayBackend(env) === 'wayland' ? 'preview' : 'frame'
}

function supportsShareArea(platform = process.platform, env = process.env) {
  return shareAreaMode(platform, env) !== null
}

const SHARE_AREA_SWITCH = '--kithmoot-share-area'

module.exports = { SHARE_AREA_SWITCH, linuxDisplayBackend, shareAreaMode, supportsShareArea }
