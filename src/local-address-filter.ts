/**
 * Keep this device's local network addresses out of what it tells a peer.
 *
 * A browser or desktop app gathering ICE candidates offers one `host`
 * candidate per network interface: the LAN addresses, a VPN's tunnel
 * address, a Tailscale or mesh address, each IPv6 unique-local address. None
 * of them is needed to reach somebody across the internet, and together they
 * are a stable fingerprint: the same set turns up in every room and survives
 * a change of VPN exit, so anyone a device has ever called can recognise it
 * again. The decision (28 October 2026) is to hide them always, on every
 * client, and accept that two devices on one network then meet through the
 * router or a relay rather than directly across the LAN.
 *
 * The rule, which kithmoot-android must keep identical:
 *
 * - A `host` candidate is sent only if its address is an mDNS name ending in
 *   `.local` (what Chromium already offers a page without media permission)
 *   or a loopback literal (127.0.0.0/8, `::1`). Every other host candidate,
 *   IP literal or any other name, is dropped.
 * - `srflx`, `prflx` and `relay` candidates are sent, with their `raddr` and
 *   `rport` rewritten to `0.0.0.0` and `0` - the related address is the local
 *   address behind the mapping, and that redaction is Chromium's own.
 * - Anything that does not parse as a candidate is dropped. The empty
 *   candidate that ends a trickle is passed through.
 * - In an SDP, the same rule applies to every `a=candidate:` line, and a
 *   `c=` or `a=rtcp:` address that is not the address of a candidate still in
 *   the SDP becomes `0.0.0.0`. Nothing else in the description is touched.
 *
 * Only what this device sends is filtered. What a peer sends is applied as
 * it arrives, because dropping a far end's candidate protects nobody.
 *
 * Deliberately textual, like `sdp-shape.ts`: a line-by-line rewrite, not a
 * parser, so fingerprints, credentials and every attribute it does not know
 * go out byte for byte as they were written.
 */

const ZERO_ADDRESS = '0.0.0.0'
const ZERO_PORT = '0'
const CANDIDATE_TYPES = new Set(['host', 'srflx', 'prflx', 'relay'])

function isIpv4Literal(address: string): boolean {
  const parts = address.split('.')
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** Any address with a colon is an IPv6 literal, zone id (`fe80::1%en0`) and all. */
function isIpv6Literal(address: string): boolean {
  return address.includes(':')
}

function isLoopback(address: string): boolean {
  if (isIpv4Literal(address)) return address.split('.')[0] === '127'
  const lower = address.toLowerCase()
  if (lower === '::1' || lower === '0:0:0:0:0:0:0:1') return true
  // An IPv4 loopback address written in IPv6's mapped form.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower)
  return mapped !== null && isIpv4Literal(mapped[1]!) && mapped[1]!.split('.')[0] === '127'
}

function isMdnsName(address: string): boolean {
  return !isIpv4Literal(address) && !isIpv6Literal(address) && /^[^\s.]+(\.[^\s.]+)*\.local$/i.test(address)
}

interface FilteredCandidate {
  /** The candidate attribute to send, `candidate:` prefix included. */
  line: string
  /** Its connection address, for the SDP's `c=` and `a=rtcp:` rule. */
  address: string
}

/**
 * The rule on one candidate attribute (`candidate:...`, no `a=`). Null when
 * it must not be sent.
 */
function filterCandidateAttribute(attribute: string): FilteredCandidate | null {
  if (!attribute.startsWith('candidate:')) return null
  const parts = attribute.slice('candidate:'.length).split(' ')
  // foundation component transport priority address port typ <type> [...]
  if (parts.length < 8 || parts.some((part) => part === '')) return null
  if (parts[6] !== 'typ') return null
  const address = parts[4]!
  const type = parts[7]!
  if (!CANDIDATE_TYPES.has(type)) return null
  if (!/^\d+$/.test(parts[1]!) || !/^\d+$/.test(parts[3]!) || !/^\d+$/.test(parts[5]!)) return null

  if (type === 'host') {
    if (!(isMdnsName(address) || ((isIpv4Literal(address) || isIpv6Literal(address)) && isLoopback(address)))) return null
  }

  // Only the related address and port change; every other extension token
  // (`tcptype`, `generation`, `ufrag`, `network-id`...) goes out as it came.
  const extensions = parts.slice(8)
  for (let i = 0; i < extensions.length; i++) {
    if (extensions[i] !== 'raddr' && extensions[i] !== 'rport') continue
    if (i + 1 >= extensions.length) return null
    extensions[i + 1] = extensions[i] === 'raddr' ? ZERO_ADDRESS : ZERO_PORT
    i++
  }
  return { line: `candidate:${[...parts.slice(0, 8), ...extensions].join(' ')}`, address }
}

/**
 * One trickled candidate attribute, as `RTCIceCandidate.candidate` holds it.
 * Returns the attribute to send, or null to send nothing. The empty string -
 * end of candidates - comes back unchanged.
 */
export function hideLocalCandidate(candidate: string): string | null {
  if (candidate === '') return ''
  return filterCandidateAttribute(candidate)?.line ?? null
}

/**
 * A trickled candidate serialised the way signalling carries it:
 * `JSON.stringify` of an `RTCIceCandidateInit`. The other fields (`sdpMid`,
 * `sdpMLineIndex`, `usernameFragment`) are kept as they were. Null to send
 * nothing, including for anything that is not such an object.
 */
export function hideLocalCandidateJson(json: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const init = parsed as Record<string, unknown>
  if (typeof init.candidate !== 'string') return null
  const candidate = hideLocalCandidate(init.candidate)
  if (candidate === null) return null
  if (candidate === init.candidate) return json
  return JSON.stringify({ ...init, candidate })
}

/** `c=IN IP4 <address>[/ttl]` or `IN IP6`. */
const CONNECTION = /^c=IN IP[46] ([^\s/]+)(\/\S*)?$/
/** `a=rtcp:<port> IN IP4 <address>` or `IN IP6`. */
const RTCP = /^a=rtcp:(\d+) IN IP[46] (\S+)$/

/**
 * An offer or answer, before it is sent. Applies the candidate rule to every
 * `a=candidate:` line and zeroes any `c=` or `a=rtcp:` address that is not
 * the connection address of a candidate still present. Line endings are
 * preserved; every other line is untouched.
 */
export function hideLocalAddressesInSdp(sdp: string): string {
  const lines = sdp.split('\n')
  const kept = new Set<string>()
  const out: (string | null)[] = lines.map((raw) => {
    const crlf = raw.endsWith('\r')
    const line = crlf ? raw.slice(0, -1) : raw
    if (!line.startsWith('a=candidate:')) return raw
    const filtered = filterCandidateAttribute(line.slice(2))
    if (!filtered) return null
    kept.add(filtered.address.toLowerCase())
    return `a=${filtered.line}${crlf ? '\r' : ''}`
  })
  return out
    .map((raw) => {
      if (raw === null) return null
      const crlf = raw.endsWith('\r')
      const line = crlf ? raw.slice(0, -1) : raw
      const end = crlf ? '\r' : ''
      const connection = CONNECTION.exec(line)
      if (connection) return kept.has(connection[1]!.toLowerCase()) ? raw : `c=IN IP4 ${ZERO_ADDRESS}${end}`
      const rtcp = RTCP.exec(line)
      if (rtcp) return kept.has(rtcp[2]!.toLowerCase()) ? raw : `a=rtcp:${rtcp[1]} IN IP4 ${ZERO_ADDRESS}${end}`
      return raw
    })
    .filter((line): line is string => line !== null)
    .join('\n')
}

/** The address-carrying fields of an outgoing signal. */
export interface AddressCarryingSignal {
  sdp?: string
  candidate?: string
  candidates?: string[]
}

/**
 * An outgoing signal with the rule applied to its SDP, its trickled
 * candidate and any batch of candidates. Null when the signal existed only to
 * carry a candidate that must not be sent. Every other field is unchanged.
 */
export function hideLocalAddressesInSignal<T extends AddressCarryingSignal>(body: T): T | null {
  let next: T = body
  if (typeof body.sdp === 'string') {
    const sdp = hideLocalAddressesInSdp(body.sdp)
    if (sdp !== body.sdp) next = { ...next, sdp }
  }
  if (Array.isArray(body.candidates)) {
    const candidates = body.candidates
      .map((candidate) => (typeof candidate === 'string' ? hideLocalCandidateJson(candidate) : null))
      .filter((candidate): candidate is string => candidate !== null)
    next = { ...next, candidates }
  }
  if (typeof body.candidate === 'string') {
    const candidate = hideLocalCandidateJson(body.candidate)
    if (candidate === null) {
      if (!Array.isArray(body.candidates)) return null
      const { candidate: _dropped, ...rest } = next
      next = rest as T
    } else if (candidate !== body.candidate) {
      next = { ...next, candidate }
    }
  }
  return next
}
