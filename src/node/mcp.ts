import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { toStdioEvent } from './brains.js'
import type { AgentRuntime, Channel } from './runtime.js'
import { CHANNELS } from './runtime.js'

/**
 * The room as an MCP server, so an MCP client - a coding agent, an IDE, a
 * desktop assistant - is the participant.
 *
 * This is the other half of "first class". A pipe (`StdioBrain`) lets any
 * process be in the room; this lets any tool-using model be in it, on its
 * own terms, with `wait_for_activity` as its ears and `chat_say` as its
 * voice. Every tool reads or writes the same runtime the other brains do,
 * so nothing here can do anything a person in the room could not.
 *
 * Runs over stdio, which is what MCP clients spawn: the protocol owns
 * stdout, so this process logs to stderr and nothing else.
 */
export async function serveMcp(runtime: AgentRuntime, opts: { name?: string; version?: string } = {}): Promise<McpServer> {
  const server = new McpServer({ name: opts.name ?? 'kithmoot', version: opts.version ?? '0.0.0' })
  const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] })
  const channel = z.enum(['chat', 'backchannel', 'transcript'])

  server.registerTool(
    'room_status',
    {
      title: 'Room status',
      description:
        'Who is in the room, grouped by person, with what they publish and whether they are an agent; and whether this agent is answering the invitation link for newcomers.',
      inputSchema: {},
    },
    async () =>
      text({
        room: runtime.agent.roomId,
        you: { participant: runtime.agent.participant, device: runtime.agent.device, name: runtime.persona.name },
        hosting: runtime.agent.hosting,
        listening: runtime.listening,
        url: runtime.agent.url,
        participants: runtime.roster().map((v) => ({
          participant: v.participant,
          name: v.name,
          agent: v.agent === true,
          devices: v.devices.length,
          tracks: v.tracks.map((t) => t.role),
        })),
      }),
  )

  server.registerTool(
    'chat_read',
    {
      title: 'Read a conversation',
      description:
        'The recent messages of one conversation. `chat` is what the people say; `backchannel` is what the agents say to each other, which the people can read too; `transcript` is what people said aloud, written down by a listening agent, with the speaker named.',
      inputSchema: { channel: channel.default('chat'), limit: z.number().int().min(1).max(200).default(50) },
    },
    async ({ channel: which, limit }) => text(runtime.history(which as Channel, limit).map((m) => toStdioEvent({ type: which as Channel, message: m, at: 0 }))),
  )

  server.registerTool(
    'chat_say',
    {
      title: 'Say something to the room',
      description: 'Send a message to the people and agents in the room. Plain text, at most 2000 characters.',
      inputSchema: { text: z.string().min(1).max(2000) },
    },
    async ({ text: body }) => {
      await runtime.say(body)
      return text('said')
    },
  )

  server.registerTool(
    'backchannel_say',
    {
      title: 'Say something to the other agents',
      description:
        'Send a message on the agents’ channel, for co-ordinating with other agents. The people in the room can read it; it is not secret from them, by design.',
      inputSchema: { text: z.string().min(1).max(2000) },
    },
    async ({ text: body }) => {
      await runtime.whisper(body)
      return text('whispered')
    },
  )

  server.registerTool(
    'wait_for_activity',
    {
      title: 'Wait for something to happen',
      description:
        'Block until a new message arrives on one of the chosen conversations, or somebody arrives or leaves, or the timeout passes. Returns the event, or nothing on timeout. Call this in a loop to follow the room.',
      inputSchema: {
        timeoutMs: z.number().int().min(100).max(300_000).default(60_000),
        channels: z.array(z.enum(['chat', 'backchannel', 'transcript', 'roster', 'approval'])).optional(),
      },
    },
    async ({ timeoutMs, channels }) => {
      const event = await runtime.next(timeoutMs, channels as Channel[] | undefined)
      if (!event) return text({ event: null, timedOut: true })
      return text({ event: toStdioEvent(event), timedOut: false })
    },
  )

  server.registerTool(
    'request_approval',
    {
      title: 'Ask a person for a decision',
      description:
        'Post a question on the room’s control channel, where everybody can see it, and wait for an answer from somebody this agent listens to: a participant on the keeper’s announced admin list, or this agent’s own verified principal. Returns the verdict (one of the options, `approve`/`decline` by default) and who gave it, or `expired` if nobody answered in time. Anybody else’s answer is ignored.',
      inputSchema: {
        text: z.string().min(1).max(500),
        options: z.array(z.string().min(1).max(32)).min(1).max(8).optional(),
        timeoutMs: z.number().int().min(1_000).max(3_600_000).default(600_000),
      },
    },
    async ({ text: body, options, timeoutMs }) => text(await runtime.requestApproval({ text: body, options, ttlSeconds: timeoutMs / 1000 })),
  )

  server.registerTool(
    'describe_room',
    {
      title: 'The room as text',
      description: 'Everything at once, as a readable briefing: who is here, and the tail of every conversation.',
      inputSchema: {},
    },
    async () => text(runtime.describe()),
  )

  server.registerTool(
    'leave_room',
    {
      title: 'Leave the room',
      description: 'Say goodbye and disconnect. The process exits shortly after.',
      inputSchema: {},
    },
    async () => {
      await runtime.close()
      setTimeout(() => process.exit(0), 200).unref()
      return text('left')
    },
  )

  for (const which of CHANNELS) {
    server.registerResource(
      `${which}-log`,
      `kithmoot://${which}`,
      { title: `${which} log`, description: `The recent ${which} messages, one JSON object per line.`, mimeType: 'application/x-ndjson' },
      async (uri) => ({
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/x-ndjson',
            text: runtime
              .history(which, 200)
              .map((m) => JSON.stringify(toStdioEvent({ type: which, message: m, at: 0 })))
              .join('\n'),
          },
        ],
      }),
    )
  }

  await server.connect(new StdioServerTransport())
  return server
}
