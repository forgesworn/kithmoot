import { describe, expect, it } from 'vitest'
import { roomBoardFileServer } from './room-board-panel.js'

const HASH = 'ab'.repeat(32)

describe('the server a card names for a file', () => {
  it('is the https server that keeps the file at its hash, with or without an extension', () => {
    expect(roomBoardFileServer(`https://files.example/${HASH}`, HASH)).toBe('https://files.example/')
    expect(roomBoardFileServer(`https://files.example:8443/${HASH}`, HASH)).toBe('https://files.example:8443/')
    expect(roomBoardFileServer(`https://files.example/${HASH}.bin`, HASH)).toBe('https://files.example/')
    expect(roomBoardFileServer(`https://files.example/${HASH}.wbenc`, HASH)).toBe('https://files.example/')
  })

  it('is nothing where a card could not find the file again from the server and the hash', () => {
    for (const url of [
      `http://files.example/${HASH}`,
      `fsl://node/${HASH}`,
      `https://files.example/blossom/${HASH}`,
      `https://files.example/${HASH}/extra`,
      `https://files.example/${HASH}.`,
      `https://files.example/${HASH}.a/b`,
      `https://files.example/${HASH}?token=1`,
      `https://files.example/${HASH}#part`,
      `https://user:pass@files.example/${HASH}`,
      `https://files.example/${'cd'.repeat(32)}`,
      'not an address',
    ]) expect(roomBoardFileServer(url, HASH), url).toBeUndefined()
    expect(roomBoardFileServer(`https://files.example/${HASH.toUpperCase()}`, HASH.toUpperCase())).toBeUndefined()
  })
})
