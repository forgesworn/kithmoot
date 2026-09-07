# @forgesworn/context-tools

Node file persistence, CLI and MCP tools for `@forgesworn/context`. MIT, ESM,
Node 22.13+. Separate from the browser-safe core: filesystem and MCP dependencies
never enter its root import. No KithMoot or NanoClaw runtime dependency.

Version 0.1.0 is published on npm and depends on the matching core package:

```sh
npm install @forgesworn/context-tools@0.1.0
```

The source is maintained in the KithMoot workspace. Build with
`npm run build:context`, then `npm pack --workspace @forgesworn/context-tools`.
For future versions, publish the matching core package first. Local tarballs
can also be installed together.

```sh
encrypted-context mcp --identity /private/assistant.key \
  --expect-pubkey '<full hexadecimal public key>' \
  --state /private/context.json --room '<64-character audience id>' \
  --server https://storage.example
```

Use `call context_list` instead of `mcp` to read a JSON request from stdin.
Use `--personal` instead of `--room` only for a separate private assistant.
Supply an existing identity; no key is minted. Startup does not contact
storage. The legacy `room` name denotes a hex audience binding; it does not
join any room. Use a separate state file for every identity and binding.

The tools are `context_list`, `context_read`, `context_create`,
`context_append`, `context_preview`, `context_import`, `context_upload`,
`context_access`, `context_grants` and `context_set_grants`. They preserve the
existing tool names and request shapes. Preview before importing. Writes stay
local until explicitly uploaded and access events delivered. Tools send no
messages and records are never execution authority.

Applications can import `ContextFileStore` from `./store`, tool registration
and dispatch from `./mcp`, or `main` from `./cli`. The CLI's `configureVault`
callback accepts trusted application configuration such as a proof verifier.
The default accepts direct identity grants and refuses unrecognised agent
proofs. KithMoot retains `kithmoot-context` with its verified ownership adapter;
existing NanoClaw MCP configurations should keep using that command.

Cache writes retain mode 0600, an exclusive writer lock, file sync and atomic
rename. Lock contention is reported for retry. A crash may leave a stale
`.lock`; only remove it after checking no process owns it. Key files and cache
locations are the operator's responsibility. MCP does not authenticate other
users of the same host account, and grants do not replace the agent host's
caller access controls.
