import { describe, expect, it } from 'vitest'
import { roomBoardFileServer, roomBoardPrivateServer } from './room-board-panel.js'

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

describe('the box a card names for a file kept on a room’s Bothy', () => {
  const node = 'ugq2dinb'.repeat(6) + 'ugqq'
  it('is the box in the private reference the upload gave, and nothing after it', () => {
    expect(roomBoardPrivateServer(`fsl://${node}/${HASH}`, HASH)).toBe(`fsl://${node}/`)
  })
  it('is nothing for any other address, or a reference to another file', () => {
    for (const url of [
      `https://files.example/${HASH}`, `fsl://${node}/${'cd'.repeat(32)}`, `fsl://${node}/${HASH}.bin`, `fsl://${node}/`,
      `fsl://${node.toUpperCase()}/${HASH}`, `fsl://${node.slice(1)}/${HASH}`, `fsl://${node}/${HASH}?x=1`, 'not an address',
    ]) expect(roomBoardPrivateServer(url, HASH), url).toBeUndefined()
    expect(roomBoardPrivateServer(`fsl://${node}/${HASH.toUpperCase()}`, HASH.toUpperCase())).toBeUndefined()
  })
})
