import { parseArgs } from 'node:util'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { generateSecretKey } from 'nostr-tools/pure'
import { nip19 } from 'nostr-tools'
import { RoomAgent } from '../agent.js'
import type { KeeperState } from '../agent.js'
import { parseKeeperState, serialiseKeeperState } from '../keeper-state.js'
import { parseForwarderRef } from '../descriptor.js'
import type { ForwarderRef } from '../types.js'
import { issueAgentOwnership, normaliseAgentOwnership, verifyAgentOwnership } from '../ownership.js'
import type { AgentOwnership } from '../types.js'
import { localIdentity } from '../identity.js'
import { checkIdentity, npubOrHex } from './identity-guard.js'
import { parseRoomLink } from '../link.js'
import { AgentRuntime } from './runtime.js'
import type { Persona } from './runtime.js'
import { AnthropicBrain, OllamaBrain, StdioBrain } from './brains.js'
import type { Brain, Completer } from './brains.js'
import { serveMcp } from './mcp.js'
import { WhisperXTranscriber, FixedTranscriber } from './transcriber.js'
import type { Transcriber } from './transcriber.js'
import { createWeriftFactory } from './webrtc.js'
import { AgentHost, loadCatalogue } from './host.js'
import { Scribe } from './scribe.js'
import { Nudger, nip17Sender } from './nudge.js'
import type { NudgeStore } from './nudge.js'
import { NostrRelayPool } from '../relay-pool.js'

const USAGE = `kithmoot-agent - be in a KithMoot room without a browser

  kithmoot-agent create --base <https://host/j/> --name <name> [--state <file>] [options]
      Make a room and keep it. Prints the link. Holds the root inviter key, so it
      admits newcomers for as long as it runs; --state persists the room across
      restarts. This is what a room that stays open for days wants. --admin
      names who may remove members, mute them or close the room from the app.
      --room-name puts a name on the link; --nudge lets members who signed in
      with a Nostr key ask to be DM'd (NIP-17, from this keeper's key, over the
      room's relays) when there are new messages and they are not in the room.

  kithmoot-agent join <link> --name <name> [options]
      Join the room behind a link, as an ordinary member, and answer that link
      for the next arrival while the delegation lasts.

  kithmoot-agent mcp <link> --name <name> [options]
      Join, and serve the room as an MCP server over stdio, so an MCP client is
      the participant. Logs go to stderr.

  kithmoot-agent host <link> --catalogue <dir> [--name <name>] [--state <dir>]
      Join as an agent host: say what agents the catalogue can run, and start
      one into the room when somebody in it clicks "Invite". Each <dir>/<id>.json
      is one agent: {"name", "brain": ollama|anthropic|none, "model", "persona",
      "description", "respond", "listen"}. Hosted agents keep their identity and
      memory under --state (default ~/.kithmoot/host).

  kithmoot-agent scribe <link> --name <name> [--brain ollama|anthropic|none] [options]
      Join listening, transcribe what reaches it, and write minutes into the
      minutes channel: when anybody types !minutes in the chat, and when a call
      ends (media had been in the room and none has been for --call-ends-after).
      A model writes attendees, decisions, actions and open questions; --brain
      none, the default here, writes the transcript grouped by speaker instead,
      so it works with no model at all.

  kithmoot-agent attest --agent <pubkey|npub> (--nsec <key> | --identity <file>) [--label <text>] [--expires <30d|12h|unix>]
      As a principal, say that an agent is yours: prints an ownership proof
      (JSON) signed by your key, to give the agent as --owner-proof. Room
      independent, attested once; set --expires if you may change your mind.

Options
  --name <name>            What the room calls this agent (required)
  --owner-proof <file>     This agent's ownership proof, from attest; carried on
                           every roster entry and message so people see whose it is
  --forwarder <json|file>  (create) A forwarder the room may promote to: the line
                           kithmoot-forwarder prints, {"url","pubkey","label"}, or a
                           file holding one or a list. Repeatable. The keeper
                           publishes the room descriptor at start, after every
                           rekey, and for every arrival, so nobody has to from the app.
  --admin <pubkey>         (create) A participant who may act on the room: remove
                           a member, close it, ask somebody to mute. Repeatable;
                           hex or npub. The keeper announces the list, signed.
  --relays <a,b>           Relay hints, comma separated (same as repeated --relay)
  --identity <file>        Participant key, hex, created if missing (kept 0600)
  --nsec <nsec|hex>        Participant key, given directly (prefer --identity)
  --expect-pubkey <k>      Refuse to start unless the key resolves to this.
                           npub or hex. Use it for any agent whose npub is
                           written down anywhere: --identity mints a fresh
                           key when the file is missing rather than failing,
                           and an agent running as the wrong key looks
                           exactly like one running correctly.
  --forbid-pubkey <k>      Refuse to start if the key resolves to this.
                           Repeatable; npub or hex. This is for PRINCIPALS -
                           a person's key, never an agent's. An agent holding
                           its principal's key can attest that it belongs to
                           itself and approve its own requests, because it is
                           the principal those checks look for.
  --relay <url>            Relay hint; repeatable. Overrides the link's.
  --ice <url>              STUN/TURN url; repeatable. Overrides the link's.
  --turn-credential <u:p>  Static credentials for every TURN url given
  --persona <file>         Markdown: the character, put in front of the model
  --memory <dir>           Append everything seen and said to <dir>/log.jsonl
  --brain <kind>           stdio (default) | ollama | anthropic | none
  --model <name>           Model for ollama (required) or anthropic (default claude-opus-5)
  --ollama-url <url>       Default http://127.0.0.1:11434
  --respond <when>         mentions (default) | always
  --listen                 Receive audio and write transcripts (needs --whisperx)
  --whisperx <url>         WhisperX server, default http://127.0.0.1:8765
  --language <code>        Force the transcription language
  --fake-transcriber       Write "(speech)" for every utterance; for plumbing checks
  --catalogue <dir>        (host) the agents this host can run
  --call-ends-after <min>  (scribe) minutes without media before the call is over; default 3
  --room-name <name>       (create) what the room is called; rides in the link
  --nudge                  (create) DM members who asked, when they miss messages
  --quiet                  No log lines on stderr

Every option can also come from the environment, for a systemd unit's
EnvironmentFile: KITHMOOT_NAME, KITHMOOT_BASE, KITHMOOT_STATE,
KITHMOOT_IDENTITY, KITHMOOT_RELAYS (comma separated), KITHMOOT_ICE (comma
separated), KITHMOOT_ADMINS (comma separated), KITHMOOT_PERSONA,
KITHMOOT_MEMORY, KITHMOOT_BRAIN, KITHMOOT_MODEL, KITHMOOT_WHISPERX,
KITHMOOT_LANGUAGE, KITHMOOT_CALL_ENDS_AFTER, KITHMOOT_OWNER_PROOF,
KITHMOOT_FORWARDER (JSON, or a file path), KITHMOOT_LINK, KITHMOOT_ROOM_NAME,
KITHMOOT_NUDGE (1 to turn it on). A flag
wins over the environment. With --state, the room link is also written
beside the state file as <state>.link, readable by the keeper's user only.

A keeper records the room's epoch, who has been removed and who asked to be
nudged in its state, so a restart reopens the same room in the same epoch,
keeps refusing the same people and keeps nudging the ones who asked. A
closed room is not reopened: delete the state to make a new one. After a
removal a v1 link that carried the room secret is dead, and the keeper
prints the current link again.
`

/** `KITHMOOT_<NAME>` from the environment, or undefined. */
function env(name: string): string | undefined {
  const value = process.env[`KITHMOOT_${name}`]
  return value === undefined || value === '' ? undefined : value
}

function envList(name: string): string[] {
  return (env(name) ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/** `KITHMOOT_<NAME>=1` (or true, yes, on) turns a switch on. */
function envFlag(name: string): boolean {
  const value = env(name)?.trim().toLowerCase()
  return value !== undefined && ['1', 'true', 'yes', 'on'].includes(value)
}

interface Common {
  name: string
  identity?: string
  nsec?: string
  relays: string[]
  ice: string[]
  turnCredential?: string
  persona?: string
  memory?: string
  brain: string
  model?: string
  ollamaUrl?: string
  respond: 'mentions' | 'always'
  listen: boolean
  whisperx?: string
  language?: string
  fakeTranscriber: boolean
  callEndsAfter?: string
  ownerProof?: string
  expectPubkey?: string
  forbidPubkey: string[]
  quiet: boolean
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      base: { type: 'string' },
      state: { type: 'string' },
      name: { type: 'string' },
      admin: { type: 'string', multiple: true },
      forwarder: { type: 'string', multiple: true },
      identity: { type: 'string' },
      nsec: { type: 'string' },
      relay: { type: 'string', multiple: true },
      relays: { type: 'string' },
      ice: { type: 'string', multiple: true },
      'turn-credential': { type: 'string' },
      persona: { type: 'string' },
      memory: { type: 'string' },
      brain: { type: 'string' },
      model: { type: 'string' },
      'ollama-url': { type: 'string' },
      respond: { type: 'string', default: 'mentions' },
      listen: { type: 'boolean', default: false },
      whisperx: { type: 'string' },
      language: { type: 'string' },
      'fake-transcriber': { type: 'boolean', default: false },
      catalogue: { type: 'string' },
      'call-ends-after': { type: 'string' },
      'room-name': { type: 'string' },
      nudge: { type: 'boolean', default: false },
      'owner-proof': { type: 'string' },
      'expect-pubkey': { type: 'string' },
      'forbid-pubkey': { type: 'string', multiple: true },
      agent: { type: 'string' },
      label: { type: 'string' },
      expires: { type: 'string' },
      quiet: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  })
  const command = positionals[0]
  if (values.help || !command || !['create', 'join', 'mcp', 'host', 'scribe', 'attest'].includes(command)) {
    process.stderr.write(USAGE)
    process.exitCode = command ? 2 : 0
    return
  }
  if (command === 'attest') {
    await attest({ agent: values.agent, nsec: values.nsec, identity: values.identity ?? env('IDENTITY'), label: values.label, expires: values.expires })
    return
  }
  const name = values.name ?? env('NAME') ?? (command === 'host' ? 'Agent host' : undefined)
  if (!name) fail('--name is required')
  if (values.respond !== 'mentions' && values.respond !== 'always') fail('--respond must be mentions or always')

  const relays = [...(values.relay ?? []), ...(values.relays ? values.relays.split(',') : [])].map((s) => s.trim()).filter(Boolean)
  const common: Common = {
    name,
    identity: values.identity ?? env('IDENTITY'),
    nsec: values.nsec,
    relays: relays.length ? relays : envList('RELAYS'),
    ice: values.ice?.length ? values.ice : envList('ICE'),
    turnCredential: values['turn-credential'],
    persona: values.persona ?? env('PERSONA'),
    memory: values.memory ?? env('MEMORY'),
    // A scribe with no model still works, so none is its default; a joiner
    // with no brain named is a pipe.
    brain: command === 'mcp' || command === 'host' ? 'none' : (values.brain ?? env('BRAIN') ?? (command === 'scribe' ? 'none' : 'stdio')),
    model: values.model ?? env('MODEL'),
    ollamaUrl: values['ollama-url'],
    respond: values.respond,
    // A scribe that cannot hear has nothing to write.
    listen: values.listen || command === 'scribe',
    whisperx: values.whisperx ?? env('WHISPERX'),
    language: values.language ?? env('LANGUAGE'),
    fakeTranscriber: values['fake-transcriber'],
    callEndsAfter: values['call-ends-after'] ?? env('CALL_ENDS_AFTER'),
    ownerProof: values['owner-proof'] ?? env('OWNER_PROOF'),
    expectPubkey: values['expect-pubkey'] ?? env('EXPECT_PUBKEY'),
    forbidPubkey: [...(values['forbid-pubkey'] ?? []), ...envList('FORBID_PUBKEY')],
    quiet: values.quiet,
  }
  // Refused before joining, so a mistyped flag does not leave a ghost in
  // the roster for the whole presence timeout.
  if (command === 'scribe' && !['ollama', 'anthropic', 'none'].includes(common.brain)) {
    fail(`a scribe is written by ollama, anthropic or none, not ${common.brain}`)
  }
  const base = values.base ?? env('BASE')
  const statePath = values.state ?? env('STATE')
  const roomName = values['room-name'] ?? env('ROOM_NAME')
  const nudge = values.nudge || envFlag('NUDGE')
  const log = common.quiet ? () => {} : (line: string) => process.stderr.write(`[kithmoot-agent] ${line}\n`)

  const participantSk = await participantKey(common, log)
  const identity = localIdentity(participantSk)

  // Said out loud on every start, and checked before anything joins a room
  // or signs a single event. An agent that has silently come up as the wrong
  // key is indistinguishable from a working one until somebody asks it in
  // chat what its own npub is - and it will answer wrongly and with
  // confidence, because nothing ever told it otherwise.
  log(`identity ${npubOrHex(identity.pubkey)}`)
  try {
    checkIdentity({ pubkey: identity.pubkey, expect: common.expectPubkey, forbid: common.forbidPubkey })
  } catch (err) {
    fail((err as Error).message)
  }
  const owner = common.ownerProof ? await loadOwnerProof(common.ownerProof, identity.pubkey) : undefined
  const persona = await loadPersona(common)
  const turn = common.turnCredential ? splitCredential(common.turnCredential) : undefined

  let agent: RoomAgent
  if (command === 'create') {
    if (!base) fail('--base is required: where the app is served, e.g. https://kithmoot.forgesworn.dev/j/')
    const state = statePath ? await loadKeeperState(statePath) : undefined
    if (state?.closed) fail(`${statePath}: this room was closed. Delete the state file to make a new one.`)
    const admins = [...(values.admin ?? []), ...envList('ADMINS')].map(adminPubkey)
    const forwarders = await forwarderRefs([...(values.forwarder ?? []), ...(env('FORWARDER') ? [env('FORWARDER')!] : [])])
    const factory = common.listen ? await createWeriftFactory({ iceUrls: common.ice, turn }) : undefined
    agent = await RoomAgent.create({
      base,
      roomName,
      name: common.name,
      identity,
      relays: common.relays.length ? common.relays : undefined,
      iceUrls: common.ice,
      factory,
      state,
      owner,
      admins,
      forwarders,
      onState: statePath ? (next) => saveKeeperState(statePath, next) : undefined,
    })
    if (statePath) {
      if (!state && agent.keeperState) await saveKeeperState(statePath, agent.keeperState)
      // The link beside the state, so an operator can `cat` it rather than
      // dig it out of a log. Same mode as the state: it is a capability.
      await writeFile(`${statePath}.link`, agent.url + '\n', { mode: 0o600 })
    }
    const epoch = agent.session.epoch
    log(`room ${agent.roomId.slice(0, 8)} open${state ? ' again' : ''}${epoch ? `, epoch ${epoch}` : ''}. link: ${agent.url}`)
    if (admins.length) log(`admins: ${admins.map((a) => a.slice(0, 8)).join(', ')}`)
    else log('no admins: only this process can remove a member or close the room')
    for (const f of forwarders) log(`forwarder: ${f.url}${f.pubkey ? ` (${f.pubkey.slice(0, 8)})` : ''}${f.label ? ` ${f.label}` : ''}, in the room descriptor`)
    agent.onEpoch((notice) => {
      const who = notice.removed.map((p) => p.slice(0, 8)).join(', ')
      log(`epoch ${notice.epoch}${who ? `: removed ${who}` : ''}${notice.by ? ` by ${notice.by.slice(0, 8)}` : ''}. link: ${agent.url}`)
    })
  } else {
    const link = positionals[1] ?? env('LINK')
    if (!link) fail(`${command} needs a link`)
    const parsed = parseRoomLink(link)
    const iceUrls = common.ice.length ? common.ice : parsed.iceUrls
    const factory = common.listen ? await createWeriftFactory({ iceUrls, turn }) : undefined
    log('joining…')
    agent = await RoomAgent.join({
      link,
      name: common.name,
      identity,
      relays: common.relays.length ? common.relays : undefined,
      factory,
      owner,
    })
    log(`joined room ${agent.roomId.slice(0, 8)} as ${agent.participant.slice(0, 8)}${agent.hosting ? ', answering the link' : ''}${agent.session.epoch ? `, epoch ${agent.session.epoch}` : ''}`)
    agent.onEpoch((notice) => {
      const who = notice.removed.map((p) => p.slice(0, 8)).join(', ')
      log(`epoch ${notice.epoch}${who ? `: removed ${who}` : ''}${notice.by ? ` by ${notice.by.slice(0, 8)}` : ''}`)
    })
  }

  const runtime = new AgentRuntime(agent, { persona, memoryDir: common.memory }).start()

  // The keeper nudges members who asked. Only a keeper: a joiner is not
  // the room's availability, and two nudgers would be two DMs.
  let nudger: Nudger | undefined
  let nudgePool: NostrRelayPool | undefined
  if (nudge && command === 'create') {
    nudgePool = new NostrRelayPool(agent.relays)
    nudger = new Nudger({
      agent,
      send: nip17Sender(participantSk, nudgePool),
      store: keeperNudgeStore(agent),
      roomName,
      log,
    })
    await nudger.start()
    log(`nudging: members who ask are DM'd once an hour at most when they miss messages${statePath ? '' : ' (no --state, so who asked is forgotten on restart)'}`)
  } else if (nudge) {
    log('--nudge only means something to a keeper (create); ignored')
  }

  if (common.listen) {
    const transcriber: Transcriber = common.fakeTranscriber
      ? new FixedTranscriber()
      : new WhisperXTranscriber({ endpoint: common.whisperx, language: common.language })
    runtime.listen(transcriber, { onError: (err) => log(`transcription: ${err instanceof Error ? err.message : String(err)}`) })
    log('listening: what reaches this agent is transcribed into the transcript channel')
  }

  const stop = () => {
    log('leaving')
    nudger?.stop()
    nudgePool?.close()
    // The farewell is the last thing out, and the process waits for it:
    // exiting first leaves a tile on everybody's screen for the whole
    // presence timeout. Bounded, because a relay that never answers must
    // not keep a process that was told to stop alive.
    const bound = new Promise<void>((resolve) => setTimeout(resolve, 3_000).unref())
    void Promise.race([runtime.close(), bound]).then(() => process.exit(0))
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  // Removed, or the room closed under this agent: there is nothing left to
  // be in. A keeper closing its own room ends the same way, and its state
  // file already says closed, so a supervisor's restart makes no new room.
  agent.onApprovalIgnored((ignored) => log(`approval ${ignored.id}: ignored "${ignored.verdict}" from ${ignored.by.slice(0, 8)} (${ignored.reason})`))
  agent.onRemoved((notice) => {
    log(`removed from the room${notice.by ? ` by ${notice.by.slice(0, 8)}` : ''}`)
    stop()
  })
  agent.onClosed((notice) => {
    log(`the room was closed${notice.by ? ` by ${notice.by.slice(0, 8)}` : ''}`)
    stop()
  })

  if (command === 'mcp') {
    await serveMcp(runtime, { name: `kithmoot:${common.name}` })
    log('mcp server ready on stdio')
    return
  }

  if (command === 'scribe') {
    const completer = makeCompleter(common, log)
    const after = Number(common.callEndsAfter ?? 3)
    if (!Number.isFinite(after) || after <= 0) fail('--call-ends-after must be a number of minutes')
    const scribe = new Scribe(runtime, { completer, callEndsAfterMs: after * 60_000, log })
    await scribe.start()
    log(
      `scribe: minutes on !minutes and ${after} minute${after === 1 ? '' : 's'} after the last media leaves, ${
        completer ? `written by ${common.brain}` : 'as the transcript grouped by speaker (no model)'
      }`,
    )
    return
  }

  if (command === 'host') {
    const dir = values.catalogue ?? env('CATALOGUE')
    if (!dir) fail('host needs --catalogue <dir>')
    const catalogue = await loadCatalogue(dir)
    if (catalogue.length === 0) fail(`${dir}: no <id>.json agents in it`)
    const host = new AgentHost({
      agent,
      catalogue,
      stateDir: statePath ?? join(homedir(), '.kithmoot', 'host'),
      log,
    })
    await host.start()
    log(`hosting ${catalogue.map((c) => c.name).join(', ')}`)
    process.once('SIGINT', () => void host.stop())
    process.once('SIGTERM', () => void host.stop())
    return
  }

  const brain = makeBrain(common, log)
  if (brain) await brain.start(runtime)
  else log('no brain: in the room, saying nothing')
}

function makeBrain(common: Common, log: (line: string) => void): Brain | undefined {
  switch (common.brain) {
    case 'stdio':
      return new StdioBrain()
    case 'ollama':
      if (!common.model) fail('--brain ollama needs --model')
      return new OllamaBrain({ model: common.model, url: common.ollamaUrl, respond: common.respond, log })
    case 'anthropic':
      return new AnthropicBrain({ model: common.model, respond: common.respond, log })
    case 'none':
      return undefined
    default:
      return fail(`unknown brain ${common.brain}`)
  }
}

/** The model behind a brain, on its own, for the scribe. */
function makeCompleter(common: Common, log: (line: string) => void): Completer | undefined {
  switch (common.brain) {
    case 'ollama':
      if (!common.model) fail('--brain ollama needs --model')
      return new OllamaBrain({ model: common.model, url: common.ollamaUrl, log }).completer()
    case 'anthropic':
      // Minutes run longer than a turn of chat.
      return new AnthropicBrain({ model: common.model, maxTokens: 4_000, log }).completer()
    case 'none':
      return undefined
    default:
      return fail(`a scribe is written by ollama, anthropic or none, not ${common.brain}`)
  }
}

async function participantKey(common: Common, log: (line: string) => void): Promise<Uint8Array> {
  if (common.nsec) {
    if (common.nsec.startsWith('nsec1')) {
      const decoded = nip19.decode(common.nsec)
      if (decoded.type !== 'nsec') fail('--nsec is not an nsec')
      return decoded.data
    }
    return hexToBytes(common.nsec)
  }
  if (common.identity) {
    try {
      const hex = (await readFile(common.identity, 'utf8')).trim()
      return hexToBytes(hex)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      const sk = generateSecretKey()
      await mkdir(dirname(common.identity), { recursive: true })
      await writeFile(common.identity, bytesToHex(sk) + '\n', { mode: 0o600 })
      // Loudly. A named key file that does not exist gets a FRESH identity
      // rather than an error, which is convenient for an ad-hoc agent and a
      // trap for a named one: the key is written, so every restart after
      // this reuses it and the deployment looks settled. If this line
      // appears for an agent whose npub is on a list somewhere, the wrong
      // key is now in place.
      log(
        `MINTED A NEW IDENTITY at ${common.identity} - that file did not exist. ` +
          'If this agent is supposed to have a published key, stop it now: it is not that key. ' +
          'Use --expect-pubkey to make this a startup failure instead.',
      )
      return sk
    }
  }
  return generateSecretKey()
}

async function loadPersona(common: Common): Promise<Persona> {
  if (!common.persona) return { name: common.name, system: '' }
  return { name: common.name, system: await readFile(common.persona, 'utf8') }
}

async function loadKeeperState(path: string): Promise<KeeperState | undefined> {
  let json: string
  try {
    json = await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw err
  }
  try {
    return parseKeeperState(json)
  } catch (err) {
    return fail(`${path}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function saveKeeperState(path: string, state: KeeperState): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, serialiseKeeperState(state), { mode: 0o600 })
}

/** Who asked to be nudged, kept in the keeper's own state - the same
 *  record the epoch and the removed ride in, saved by the same `onState`,
 *  so it survives a restart and is backed up with the room. */
function keeperNudgeStore(agent: RoomAgent): NudgeStore {
  return {
    load: async () => [...(agent.keeperState?.nudge ?? [])],
    save: (pubkeys) => agent.amendKeeperState({ nudge: pubkeys }),
  }
}

/**
 * `--forwarder` values: each is JSON (an object, or a list of them) or the
 * path of a file holding the same. Refused with a reason before the keeper
 * joins anything.
 */
async function forwarderRefs(values: string[]): Promise<ForwarderRef[]> {
  const out: ForwarderRef[] = []
  for (const value of values) {
    const trimmed = value.trim()
    let text = trimmed
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
      try {
        text = await readFile(trimmed, 'utf8')
      } catch (err) {
        return fail(`--forwarder ${trimmed}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      return fail(`--forwarder ${trimmed.slice(0, 60)}: not JSON. Expected the line kithmoot-forwarder prints: {"url","pubkey","label"}`)
    }
    for (const entry of Array.isArray(raw) ? raw : [raw]) {
      try {
        out.push(parseForwarderRef(entry))
      } catch (err) {
        return fail(`--forwarder: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }
  return out
}

/** A proof from `attest`, checked here against this agent's own key so a
 *  proof for some other agent fails at start rather than being carried
 *  around and dropped by every reader. */
async function loadOwnerProof(path: string, agent: string): Promise<AgentOwnership> {
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(path, 'utf8'))
  } catch (err) {
    return fail(`--owner-proof ${path}: ${err instanceof Error ? err.message : String(err)}`)
  }
  const proof = normaliseAgentOwnership(raw)
  if (!proof) return fail(`--owner-proof ${path}: not an ownership proof`)
  const verdict = verifyAgentOwnership(proof, { agent, now: Math.floor(Date.now() / 1000) })
  if (!verdict.ok) return fail(`--owner-proof ${path}: ${verdict.reason}`)
  return proof
}

/** `attest`: a principal signs that an agent is theirs. Stdout, so it can
 *  go straight to a file; nothing else is printed there. */
async function attest(opts: { agent?: string; nsec?: string; identity?: string; label?: string; expires?: string }): Promise<void> {
  if (!opts.agent) fail('attest needs --agent <pubkey|npub>: the agent this proof is about')
  if (!opts.nsec && !opts.identity) fail('attest needs the principal key: --nsec or --identity (an existing file)')
  const agent = pubkeyArg(opts.agent, '--agent')
  let principalSk: Uint8Array
  if (opts.nsec) {
    principalSk = await participantKey({ nsec: opts.nsec } as Common, (line) =>
      process.stderr.write(`[kithmoot-agent] ${line}\n`),
    )
  } else {
    try {
      principalSk = hexToBytes((await readFile(opts.identity!, 'utf8')).trim())
    } catch (err) {
      return fail(`--identity ${opts.identity}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  const issuedAt = Math.floor(Date.now() / 1000)
  const expiresAt = opts.expires === undefined ? undefined : expiryArg(opts.expires, issuedAt)
  const proof = issueAgentOwnership({ principalSk, agent, issuedAt, expiresAt, label: opts.label })
  process.stdout.write(JSON.stringify(proof, null, 2) + '\n')
}

/** `30d`, `12h`, `90m`, or unix seconds. */
function expiryArg(raw: string, now: number): number {
  const m = /^(\d+)([dhm])$/.exec(raw.trim())
  if (m) {
    const n = Number(m[1])
    const unit = m[2] === 'd' ? 86_400 : m[2] === 'h' ? 3_600 : 60
    if (n <= 0) fail('--expires must be positive')
    return now + n * unit
  }
  const at = Number(raw)
  if (Number.isSafeInteger(at) && at > now) return at
  return fail('--expires must be a duration like 30d, 12h or 90m, or unix seconds in the future')
}

/** A pubkey as typed: hex or npub, to lower-case hex. */
function pubkeyArg(raw: string, flag: string): string {
  const value = raw.trim()
  if (value.startsWith('npub1')) {
    try {
      const decoded = nip19.decode(value)
      if (decoded.type === 'npub') return decoded.data
    } catch {
      // Falls through to the failure below.
    }
    return fail(`${flag} ${value}: not an npub`)
  }
  if (!/^[0-9a-fA-F]{64}$/.test(value)) return fail(`${flag} ${value}: not a pubkey (64 hex characters or an npub)`)
  return value.toLowerCase()
}

/** An admin as typed: hex or npub, to lower-case hex. */
function adminPubkey(raw: string): string {
  const value = raw.trim()
  if (value.startsWith('npub1')) {
    try {
      const decoded = nip19.decode(value)
      if (decoded.type === 'npub') return decoded.data
    } catch {
      // Falls through to the failure below.
    }
    return fail(`--admin ${value}: not an npub`)
  }
  if (!/^[0-9a-fA-F]{64}$/.test(value)) return fail(`--admin ${value}: not a pubkey (64 hex characters or an npub)`)
  return value.toLowerCase()
}

function splitCredential(pair: string): { username: string; credential: string } {
  const at = pair.indexOf(':')
  if (at <= 0) fail('--turn-credential must be user:password')
  return { username: pair.slice(0, at), credential: pair.slice(at + 1) }
}

function fail(message: string): never {
  process.stderr.write(`kithmoot-agent: ${message}\n`)
  process.exit(2)
}
