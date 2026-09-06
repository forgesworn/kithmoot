import { parseArgs } from 'node:util'
import { readFile } from 'node:fs/promises'
import { hexToBytes } from '@noble/hashes/utils'
import { localIdentity } from '../identity.js'
import { localPeerCrypt } from '../dm.js'
import { ContextFileStore } from './context-store.js'
import { serveContextMcp, callContextTool } from './context-mcp.js'

export async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    identity: { type: 'string' }, state: { type: 'string' }, room: { type: 'string' },
    'expect-pubkey': { type: 'string' }, personal: { type: 'boolean' },
    server: { type: 'string', multiple: true }, help: { type: 'boolean' },
  } })
  if (values.help) {
    process.stdout.write('kithmoot-context mcp|call <tool> --identity <existing agent hex-key file> --expect-pubkey <agent hex pubkey> --state <encrypted cache> --room <room hex id> [--server <HTTPS origin> ...]\nUse --personal instead of --room only for a separate private assistant. CLI call reads a JSON object from stdin. No key is generated and no network is contacted on startup.\n')
    return
  }
  if (!values.identity || !values.state || !values['expect-pubkey'] || (!!values.room === !!values.personal)) throw new Error('Supply --identity, --expect-pubkey, --state and exactly one of --room or --personal. See --help.')
  if (!['mcp', 'call'].includes(positionals[0]) || positionals.length !== (positionals[0] === 'call' ? 2 : 1)) throw new Error('Choose mcp, or call <tool>.')
  const raw = (await readFile(values.identity, 'utf8')).trim()
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) throw new Error('Identity file must contain an existing agent’s 32-byte hexadecimal key.')
  const sk = hexToBytes(raw), identity = { ...localIdentity(sk), ...localPeerCrypt(sk) }
  if (identity.pubkey !== values['expect-pubkey']) throw new Error('Identity does not match the pinned agent pubkey.')
  const store = new ContextFileStore(values.state, { identity, room: values.room, servers: values.server })
  if (positionals[0] === 'mcp') { await serveContextMcp(store); return }
  let input = ''
  for await (const part of process.stdin) { input += part; if (input.length > 120000) throw new Error('Context request too large.') }
  let args
  try { args = JSON.parse(input || '{}') } catch { throw new Error('Invalid context request JSON.') }
  process.stdout.write(JSON.stringify(await callContextTool(store, positionals[1], args), null, 2) + '\n')
}
