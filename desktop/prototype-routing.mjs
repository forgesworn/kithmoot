// Experimental desktop routing only. This follows the OS default route; it
// neither detects Proton nor keeps traffic on a VPN after that route changes.
export const PROTOTYPE_IP_POLICY = 'default_public_interface_only'

export function applyPrototypeRouting(contents, { packaged, requested }) {
  if (packaged || requested !== '1') return false
  contents.setWebRTCIPHandlingPolicy(PROTOTYPE_IP_POLICY)
  if (contents.getWebRTCIPHandlingPolicy() !== PROTOTYPE_IP_POLICY) {
    throw new Error('The requested desktop routing prototype could not be applied')
  }
  return true
}
