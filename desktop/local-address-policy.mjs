// Every main window keeps this device's local network addresses out of calls.
// Electron's `default_public_interface_only` gathers on the default route
// only and offers no host candidate, so a peer learns the public address a
// STUN server reports (or a relay's) and never the LAN, VPN tunnel, Tailscale
// or mesh addresses behind it. The shared library applies the same rule to
// every signal it sends (src/local-address-filter.ts); this is the engine
// half on desktop, so nothing is gathered that the filter would then have to
// catch. It follows the OS default route: it neither detects a VPN nor keeps
// traffic on one after that route changes.
export const LOCAL_ADDRESS_POLICY = 'default_public_interface_only'

// Throws unless Electron confirms the policy, so a window that cannot hide
// local addresses is refused before it navigates or opens a connection.
export function applyLocalAddressPolicy(contents) {
  contents.setWebRTCIPHandlingPolicy(LOCAL_ADDRESS_POLICY)
  if (contents.getWebRTCIPHandlingPolicy() !== LOCAL_ADDRESS_POLICY) {
    throw new Error('Desktop could not hide local network addresses from calls')
  }
}
