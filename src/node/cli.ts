import { parseArgs } from 'node:util'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { generateSecretKey } from 'nostr-tools/pure'
import { nip19 } from 'nostr-tools'
import { RoomAgent } from '../agent.js'
import type { KeeperState } from '../agent.js'
import { localIdentity } from '../identity.js'
import { parseRoomLink } from '../link.js'
import { AgentRuntime } from './runtime.js'
import type { Persona } from './runtime.js'
import { AnthropicBrain, OllamaBrain, StdioBrain } from './brains.js'
import type { Brain } from './brains.js'
import { serveMcp } from './mcp.js'
import { WhisperXTranscriber, FixedTranscriber } from './transcriber.js'
import type { Transcriber } from './transcriber.js'
import { createWeriftFactory } from './webrtc.js'

const USAGE = `kithmoot-agent - be in a KithMoot room without a browser

  kithmoot-agent create --base <https://host/j/> --name <name> [--state <file>] [options]
      Make a room and keep it. Prints the link. Holds the root inviter key, so it
      admits newcomers for as long as it runs; --state persists the room across
      restarts. This is what a room that stays open for days wants.

  kithmoot-agent join <link> --name <name> [options]
      Join the room behind a link, as an ordinary member, and answer that link
      for the next arrival while the delegation lasts.

  kithmoot-agent mcp <link> --name <name> [options]
      Join, and serve the room as an MCP server over stdio, so an MCP client is
      the participant. Logs go to stderr.

Options
  --name <name>            What the room calls this agent (required)
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
  --quiet                  No log lines on stderr
`

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
      identity: { type: 'string' },
      nsec: { type: 'string' },
      relay: { type: 'string', multiple: true },
      ice: { type: 'string', multiple: true },
      'turn-credential': { type: 'string' },
      persona: { type: 'string' },
      memory: { type: 'string' },
      brain: { type: 'string', default: 'stdio' },
      model: { type: 'string' },
      'ollama-url': { type: 'string' },
      respond: { type: 'string', default: 'mentions' },
      listen: { type: 'boolean', default: false },
      whisperx: { type: 'string' },
      language: { type: 'string' },
      'fake-transcriber': { type: 'boolean', default: false },
      quiet: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  })
  const command = positionals[0]
  if (values.help || !command || !['create', 'join', 'mcp'].includes(command)) {
    process.stderr.write(USAGE)
    process.exitCode = command ? 2 : 0
    return
  }
  if (!values.name) fail('--name is required')
  if (values.respond !== 'mentions' && values.respond !== 'always') fail('--respond must be mentions or always')

  const common: Common = {
    name: values.name,
    identity: values.identity,
    nsec: values.nsec,
    relays: values.relay ?? [],
    ice: values.ice ?? [],
    turnCredential: values['turn-credential'],
    persona: values.persona,
    memory: values.memory,
    brain: command === 'mcp' ? 'none' : values.brain,
    model: values.model,
    ollamaUrl: values['ollama-url'],
    respond: values.respond,
    listen: values.listen,
    whisperx: values.whisperx,
    language: values.language,
    fakeTranscriber: values['fake-transcriber'],
    quiet: values.quiet,
  }
  const log = common.quiet ? () => {} : (line: string) => process.stderr.write(`[kithmoot-agent] ${line}\n`)

  const identity = localIdentity(await participantKey(common))
  const persona = await loadPersona(common)
  const turn = common.turnCredential ? splitCredential(common.turnCredential) : undefined

  let agent: RoomAgent
  if (command === 'create') {
    if (!values.base) fail('--base is required: where the app is served, e.g. https://kithmoot.forgesworn.dev/j/')
    const state = values.state ? await loadKeeperState(values.state) : undefined
    const factory = common.listen ? await createWeriftFactory({ iceUrls: common.ice, turn }) : undefined
    agent = await RoomAgent.create({
      base: values.base,
      name: common.name,
      identity,
      relays: common.relays.length ? common.relays : undefined,
      iceUrls: common.ice,
      factory,
      state,
    })
    if (values.state && !state && agent.keeperState) await saveKeeperState(values.state, agent.keeperState)
    log(`room open. link: ${agent.url}`)
  } else {
    const link = positionals[1]
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
    log(`joined room ${agent.roomId.slice(0, 8)} as ${agent.participant.slice(0, 8)}${agent.hosting ? ', answering the link' : ''}`)
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
    void runtime.close().then(() => process.exit(0))
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)

  if (command === 'mcp') {
    await serveMcp(runtime, { name: `kithmoot:${common.name}` })
    log('mcp server ready on stdio')
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

interface StoredKeeperState {
  v: 1
  secret: string
  inviterSk: string
  bearer: string
}

async function loadKeeperState(path: string): Promise<KeeperState | undefined> {
  try {
    const stored = JSON.parse(await readFile(path, 'utf8')) as StoredKeeperState
    if (stored.v !== 1) fail(`${path}: unknown keeper state version`)
    return { secret: hexToBytes(stored.secret), inviterSk: hexToBytes(stored.inviterSk), bearer: hexToBytes(stored.bearer) }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw err
  }
}

async function saveKeeperState(path: string, state: KeeperState): Promise<void> {
  const stored: StoredKeeperState = {
    v: 1,
    secret: bytesToHex(state.secret),
    inviterSk: bytesToHex(state.inviterSk),
    bearer: bytesToHex(state.bearer),
  }
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(stored, null, 2) + '\n', { mode: 0o600 })
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
