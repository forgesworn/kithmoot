import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * The TURN server keeps no log (deploy/coturn/turnserver.conf). A relay has
 * to know the addresses at both ends of a call while it carries it, and has
 * no reason to write them down. This holds the template to that: logging
 * goes nowhere, and nothing that turns per-session records back on is set.
 */
const active = readFileSync('deploy/coturn/turnserver.conf', 'utf8')
  .split('\n')
  .map(line => line.trim())
  .filter(line => line !== '' && !line.startsWith('#'))
const option = (line: string) => line.replace(/^--/, '').split('=')[0]!.toLowerCase()

describe('coturn keeps no log', () => {
  it('sends its log nowhere, with no copy to stdout', () => {
    expect(active.filter(line => option(line) === 'log-file')).toEqual(['log-file=/dev/null'])
    expect(active).toContain('no-stdout-log')
    // Without it coturn keeps writing everything to /var/tmp/turn_1_<date>.log
    // inside the container, whatever log-file says.
    expect(active).toContain('simple-log')
  })

  it('sets nothing that records sessions, bindings or addresses', () => {
    for (const recorder of ['verbose', 'v', 'very-verbose', 'log-binding', 'syslog', 'prometheus', 'cli']) {
      expect(active.map(option)).not.toContain(recorder)
    }
  })
})
