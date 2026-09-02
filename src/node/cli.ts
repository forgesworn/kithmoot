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
import { localIdentity } from '../identity.js'
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

const USAGE = `kithmoot-agent - be in a KithMoot room without a browser

  kithmoot-agent create --base <https://host/j/> --name <name> [--state <file>] [options]
      Make a room and keep it. Prints the link. Holds the root inviter key, so it
      admits newcomers for as long as it runs; --state persists the room across
      restarts. This is what a room that stays open for days wants. --admin
      names who may remove members, mute them or close the room from the app.

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

Options
  --name <name>            What the room calls this agent (required)
  --admin <pubkey>         (create) A participant who may act on the room: remove
                           a member, close it, ask somebody to mute. Repeatable;
                           hex or npub. The keeper announces the list, signed.
  --relays <a,b>           Relay hints, comma separated (same as repeated --relay)
  --identity <file>        Participant key, hex, created if missing (kept 0600)
  --nsec <nsec|hex>        Participant key, given directly (prefer --identity)
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
  --quiet                  No log lines on stderr

Every option can also come from the environment, for a systemd unit's
EnvironmentFile: KITHMOOT_NAME, KITHMOOT_BASE, KITHMOOT_STATE,
KITHMOOT_IDENTITY, KITHMOOT_RELAYS (comma separated), KITHMOOT_ICE (comma
separated), KITHMOOT_ADMINS (comma separated), KITHMOOT_PERSONA,
KITHMOOT_MEMORY, KITHMOOT_BRAIN, KITHMOOT_MODEL, KITHMOOT_WHISPERX,
KITHMOOT_LANGUAGE, KITHMOOT_CALL_ENDS_AFTER, KITHMOOT_LINK. A flag wins over
the environment. With --state, the room link is also written beside the
state file as <state>.link, readable by the keeper's user only.

A keeper records the room's epoch and who has been removed in its state, so
a restart reopens the same room in the same epoch and keeps refusing the
same people. A closed room is not reopened: delete the state to make a new
one. After a removal a v1 link that carried the room secret is dead, and the
keeper prints the current link again.
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
      quiet: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  })
  const command = positionals[0]
  if (values.help || !command || !['create', 'join', 'mcp', 'host', 'scribe'].includes(command)) {
    process.stderr.write(USAGE)
    process.exitCode = command ? 2 : 0
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
    quiet: values.quiet,
  }
  // Refused before joining, so a mistyped flag does not leave a ghost in
  // the roster for the whole presence timeout.
  if (command === 'scribe' && !['ollama', 'anthropic', 'none'].includes(common.brain)) {
    fail(`a scribe is written by ollama, anthropic or none, not ${common.brain}`)
  }
  const base = values.base ?? env('BASE')
  const statePath = values.state ?? env('STATE')
  const log = common.quiet ? () => {} : (line: string) => process.stderr.write(`[kithmoot-agent] ${line}\n`)

  const identity = localIdentity(await participantKey(common))
  const persona = await loadPersona(common)
  const turn = common.turnCredential ? splitCredential(common.turnCredential) : undefined

  let agent: RoomAgent
  if (command === 'create') {
    if (!base) fail('--base is required: where the app is served, e.g. https://kithmoot.forgesworn.dev/j/')
    const state = statePath ? await loadKeeperState(statePath) : undefined
    if (state?.closed) fail(`${statePath}: this room was closed. Delete the state file to make a new one.`)
    const admins = [...(values.admin ?? []), ...envList('ADMINS')].map(adminPubkey)
    const factory = common.listen ? await createWeriftFactory({ iceUrls: common.ice, turn }) : undefined
    agent = await RoomAgent.create({
      base,
      name: common.name,
      identity,
      relays: common.relays.length ? common.relays : undefined,
      iceUrls: common.ice,
      factory,
      state,
      admins,
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
    })
    log(`joined room ${agent.roomId.slice(0, 8)} as ${agent.participant.slice(0, 8)}${agent.hosting ? ', answering the link' : ''}${agent.session.epoch ? `, epoch ${agent.session.epoch}` : ''}`)
    agent.onEpoch((notice) => {
      const who = notice.removed.map((p) => p.slice(0, 8)).join(', ')
      log(`epoch ${notice.epoch}${who ? `: removed ${who}` : ''}${notice.by ? ` by ${notice.by.slice(0, 8)}` : ''}`)
    })
  }

  const runtime = new AgentRuntime(agent, { persona, memoryDir: common.memory }).start()

  if (common.listen) {
    const transcriber: Transcriber = common.fakeTranscriber
      ? new FixedTranscriber()
      : new WhisperXTranscriber({ endpoint: common.whisperx, language: common.language })
    runtime.listen(transcriber, { onError: (err) => log(`transcription: ${err instanceof Error ? err.message : String(err)}`) })
    log('listening: what reaches this agent is transcribed into the transcript channel')
  }

  const stop = () => {
    log('leaving')
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

async function participantKey(common: Common): Promise<Uint8Array> {
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
