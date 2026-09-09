/** JSON-lines interface version. Additive fields are compatible; changing an
 * existing command or event's meaning requires a new version. */
export const STDIO_PROTOCOL = { protocol: 'kithmoot-agent-stdio', version: 1 } as const
