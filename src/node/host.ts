import { spawn as nodeSpawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import type { RoomAgent } from '../agent.js'
import type { ChatMessage } from '../chat.js'
import { CONTROL_CHANNEL, decodeControl, encodeControl } from '../control.js'
import type { CatalogueEntry, ControlMessage, RunningAgent } from '../control.js'

/**
 * One agent a host knows how to run: a persona and the way it is driven.
 * Read from `<catalogue>/<id>.json`; paths in it are relative to that
 * directory.
 */
export interface HostedAgentConfig extends CatalogueEntry {
  /** Markdown, the character. */
  persona?: string
  brain: 'ollama' | 'anthropic' | 'none'
  model?: string
  respond?: 'mentions' | 'always'
  /** Transcribe what it is allowed to hear. */
  listen?: boolean
  whisperx?: string
  language?: string
  /** Where it keeps its memory. Defaults to `<state>/<id>/memory`. */
  memory?: string
}

/** Enough of `child_process.spawn` to be handed a fake. */
export type SpawnFn = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; stdio: ['ignore', 'ignore', 'pipe'] },
) => Pick<ChildProcess, 'pid' | 'kill' | 'on' | 'stderr' | 'exitCode'>

export interface AgentHostOptions {
  /** The host's own membership. It should be an agent itself. */
  agent: RoomAgent
  /** What it can run. */
  catalogue: HostedAgentConfig[]
  /** Where identities and memory for hosted agents live. */
  stateDir: string
  /** The command that runs an agent: the CLI, by default. */
  command?: { file: string; args: string[] }
  /** Handed to every hosted agent, on top of the host's own. An API key
   *  for a model lives here, never in the catalogue. */
  env?: NodeJS.ProcessEnv
  spawn?: SpawnFn
  log?: (line: string) => void
  now?: () => number
}

/**
 * A member of the room that starts other members on request.
 *
 * "Single click to invite an agent" needs somewhere for the agent to run,
 * and this is it: a process on a machine with a model behind it - the box
 * that keeps the room, or a laptop with Ollama - that sits in the room,
 * says what it can run, and runs one when a person clicks it. Every
 * hosted agent is an ordinary `kithmoot-agent join` with its own identity
 * and its own memory, admitted through the room's link like anybody else;
 * the host only starts and stops the process.
 *
 * Anybody in the room may ask, because anybody in the room holds the room
 * key and the channel is the room's. What a person cannot do is run
 * something the host did not put in its catalogue, or run it anywhere but
 * on the host's machine.
 */
export class AgentHost {
  readonly #agent: RoomAgent
  readonly #catalogue = new Map<string, HostedAgentConfig>()
  readonly #stateDir: string
  readonly #command: { file: string; args: string[] }
  readonly #env: NodeJS.ProcessEnv
  readonly #spawn: SpawnFn
  readonly #log: (line: string) => void
  readonly #now: () => number
  readonly #running = new Map<string, { child: ReturnType<SpawnFn>; since: number; participant: string }>()
  readonly #startedAt: number
  #unsub?: () => void
  #closed = false

  constructor(opts: AgentHostOptions) {
    this.#agent = opts.agent
    for (const entry of opts.catalogue) this.#catalogue.set(entry.id, entry)
    this.#stateDir = opts.stateDir
    this.#command = opts.command ?? {
      file: process.execPath,
      args: [resolve(dirname(new URL(import.meta.url).pathname), '..', '..', '..', 'bin', 'kithmoot-agent.mjs')],
    }
    this.#env = { ...process.env, ...(opts.env ?? {}) }
    this.#spawn = opts.spawn ?? (nodeSpawn as unknown as SpawnFn)
    this.#log = opts.log ?? (() => {})
    this.#now = opts.now ?? (() => Math.floor(Date.now() / 1000))
    this.#startedAt = this.#now()
  }

  get host(): string {
    return this.#agent.participant
  }

  /** What it can run, as the room sees it. */
  catalogue(): CatalogueEntry[] {
    return [...this.#catalogue.values()].map(({ id, name, description, listen }) => ({
      id,
      name,
      ...(description ? { description } : {}),
      ...(listen ? { listens: true } : {}),
    }))
  }

  running(): RunningAgent[] {
    return [...this.#running].map(([id, r]) => ({ id, name: this.#catalogue.get(id)?.name ?? id, participant: r.participant, since: r.since }))
  }

  async start(): Promise<void> {
    const log = this.#agent.channel(CONTROL_CHANNEL)
    this.#unsub = log.onChange((messages) => {
      for (const m of messages) void this.#handle(m)
    })
    await this.#announce()
  }

  readonly #seen = new Set<string>()

  async #handle(m: ChatMessage): Promise<void> {
    if (this.#closed || this.#seen.has(m.id)) return
    this.#seen.add(m.id)
    // Replayed history: an invitation sent before this host existed was
    // for a host that is gone, not for this one.
    if (m.sentAt < this.#startedAt - 10) return
    if (m.participant === this.host) return
    const control = decodeControl(m.text)
    if (!control) return
    switch (control.op) {
      case 'catalogue?':
        await this.#announce()
        return
      case 'invite':
        if (control.host !== this.host) return
        await this.invite(control.agent)
        return
      case 'dismiss':
        if (control.host !== this.host) return
        await this.dismiss(control.agent)
        return
      default:
        return
    }
  }

  async #say(message: ControlMessage): Promise<void> {
    if (this.#closed) return
    try {
      await this.#agent.channel(CONTROL_CHANNEL).send(encodeControl(message))
    } catch (err) {
      this.#log(`control: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  async #announce(): Promise<void> {
    await this.#say({ op: 'catalogue', host: this.host, name: this.#agent.session.participants().find((v) => v.participant === this.host)?.name ?? 'Agent host', agents: this.catalogue(), running: this.running() })
  }

  /** Start one. Idempotent: an agent already running is left running. */
  async invite(id: string): Promise<void> {
    const config = this.#catalogue.get(id)
    if (!config) {
      await this.#say({ op: 'error', host: this.host, agent: id, message: 'no such agent in this host’s catalogue' })
      return
    }
    if (this.#running.has(id)) {
      await this.#say({ op: 'invited', host: this.host, agent: id, name: config.name, participant: this.#running.get(id)!.participant })
      return
    }
    try {
      const dir = join(this.#stateDir, id)
      await mkdir(dir, { recursive: true })
      const identity = join(dir, 'identity.key')
      const participant = await this.#identityAt(identity)
      const args = [...this.#command.args, 'join', this.#agent.url, '--name', config.name, '--identity', identity, '--brain', config.brain, '--respond', config.respond ?? 'mentions', '--memory', config.memory ?? join(dir, 'memory'), '--quiet']
      if (config.persona) args.push('--persona', config.persona)
      if (config.model) args.push('--model', config.model)
      if (config.listen) args.push('--listen')
      if (config.whisperx) args.push('--whisperx', config.whisperx)
      if (config.language) args.push('--language', config.language)
      const child = this.#spawn(this.#command.file, args, { env: this.#env, stdio: ['ignore', 'ignore', 'pipe'] })
      const since = this.#now()
      this.#running.set(id, { child, since, participant })
      child.stderr?.on('data', (chunk: Buffer) => this.#log(`${config.name}: ${chunk.toString().trim()}`))
      child.on('exit', (code) => {
        if (this.#running.get(id)?.child !== child) return
        this.#running.delete(id)
        this.#log(`${config.name} exited (${code ?? 'signal'})`)
        void this.#say({ op: 'dismissed', host: this.host, agent: id, name: config.name, ...(code ? { reason: `exited with ${code}` } : {}) })
        void this.#announce()
      })
      this.#log(`started ${config.name} (${participant.slice(0, 8)})`)
      await this.#say({ op: 'invited', host: this.host, agent: id, name: config.name, participant })
      await this.#announce()
    } catch (err) {
      await this.#say({ op: 'error', host: this.host, agent: id, message: (err instanceof Error ? err.message : String(err)).slice(0, 140) })
    }
  }

  /** Stop one. */
  async dismiss(id: string): Promise<void> {
    const running = this.#running.get(id)
    if (!running) {
      await this.#say({ op: 'error', host: this.host, agent: id, message: 'not running' })
      return
    }
    running.child.kill('SIGTERM')
    // The exit handler says `dismissed` and re-announces.
  }

  /** The participant key for a hosted agent, kept so it is the same agent
   *  next time. Mode 0600, like every key this project writes. */
  async #identityAt(path: string): Promise<string> {
    try {
      return getPublicKey(hexToBytes((await readFile(path, 'utf8')).trim()))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      const sk = generateSecretKey()
      await writeFile(path, bytesToHex(sk) + '\n', { mode: 0o600 })
      return getPublicKey(sk)
    }
  }

  async stop(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    this.#unsub?.()
    for (const [, r] of this.#running) r.child.kill('SIGTERM')
    this.#running.clear()
  }
}

/**
 * Read a catalogue directory: every `*.json` is one agent, its `id` the
 * file name, its `persona` resolved against the directory.
 */
export async function loadCatalogue(dir: string): Promise<HostedAgentConfig[]> {
  const out: HostedAgentConfig[] = []
  for (const file of (await readdir(dir)).filter((f) => f.endsWith('.json')).sort()) {
    const raw = JSON.parse(await readFile(join(dir, file), 'utf8')) as Partial<HostedAgentConfig>
    const id = file.slice(0, -'.json'.length)
    if (!raw.name) throw new Error(`${file}: needs a name`)
    if (!raw.brain || !['ollama', 'anthropic', 'none'].includes(raw.brain)) throw new Error(`${file}: brain must be ollama, anthropic or none`)
    if (raw.brain === 'ollama' && !raw.model) throw new Error(`${file}: an ollama agent needs a model`)
    out.push({
      ...raw,
      id,
      name: raw.name,
      brain: raw.brain,
      ...(raw.persona ? { persona: resolve(dir, raw.persona) } : {}),
    })
  }
  return out
}
