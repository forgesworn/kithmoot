import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PASSWORD_ITERATIONS, PASSWORD_WORDS, generatePasswordWords, openInvitation, parsePasswordWords, passwordAdditionalData, sealInvitation,
} from '../app/src/meeting-codes.js'

// vectors/meeting-code-password-v1.json is generated with node:crypto by
// generate-meeting-code-password.mjs; the app's WebCrypto code must
// reproduce it byte for byte, and open it.
const here = dirname(fileURLToPath(import.meta.url))
const vector = JSON.parse(readFileSync(join(here, 'meeting-code-password-v1.json'), 'utf8'))
const hex = (value: string) => new Uint8Array(Buffer.from(value, 'hex'))

describe('meeting code password vector v1', () => {
  it('names the pinned word list and the words its indices give', () => {
    expect(vector.wordList).toEqual({ name: 'foregather en-v1', count: 2048, sha256: '0334930ebdfbc76e81ec914515d7567ca85738a6bf3069249d97df951d44661c' })
    expect(PASSWORD_WORDS.length).toBe(vector.wordList.count)
    const indices: number[] = vector.input.wordIndices
    expect(generatePasswordWords(array => array.map((_, i) => indices[i]!) as Uint16Array)).toBe(vector.input.words)
    for (const typed of vector.input.typedVariants) expect(parsePasswordWords(typed)).toBe(vector.input.words)
    expect(vector.input.iterations).toBe(PASSWORD_ITERATIONS)
  })

  it('binds the code and expiry and seals the exact bytes', async () => {
    const { words, code, expires, link, saltHex, nonceHex } = vector.input
    expect(passwordAdditionalData(code, expires)).toBe(vector.intermediate.additionalData)
    expect(JSON.stringify({ v: 1, link })).toBe(vector.intermediate.plaintext)
    expect(Buffer.from(vector.envelope.ciphertext, 'base64url').toString('hex')).toBe(vector.intermediate.ciphertextHex)
    const sealed = await sealInvitation({ link, words, code, expires, salt: hex(saltHex), nonce: hex(nonceHex) })
    expect(sealed).toEqual(vector.envelope)
    expect(await openInvitation({ envelope: vector.envelope, words: vector.input.typedVariants[1], code, expires })).toBe(link)
  }, 20_000)

  it('was built from the frozen list', () => {
    const text = readFileSync(join(here, '..', 'app', 'src', 'meeting-code-words-en-v1.txt'), 'utf8')
    expect(createHash('sha256').update(text).digest('hex')).toBe(vector.wordList.sha256)
  })
})
