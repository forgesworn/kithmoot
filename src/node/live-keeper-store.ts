import { DatabaseSync } from 'node:sqlite'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { LiveKeeperStore } from '../live-keeper.js'

const LIMIT = 2 * 1024 * 1024
const AAD = Buffer.from('kithmoot/v1/live-keeper-journal', 'utf8')

/** Local filesystem only. Never delete the adjacent lease database to recover a process. */
export class EncryptedLiveKeeperStore implements LiveKeeperStore {
  readonly path: string
  #key: Buffer
  #lease: DatabaseSync | undefined
  #leasePath: string
  #leaseInode = 0
  #leaseDevice = 0
  #closed = false

  constructor(path: string, key: Uint8Array) {
    if (key.length !== 32) throw new Error('live keeper storage needs a separate 32-byte key')
    const directory = realpathSync(dirname(resolve(path)))
    const owner = statSync(directory)
    if (!owner.isDirectory() || (owner.mode & 0o077) !== 0 || owner.uid !== process.getuid?.()) throw new Error('live keeper storage needs a private owner-only directory')
    this.path = join(directory, basename(path))
    this.#leasePath = `${this.path}.lease.sqlite`
    this.#key = Buffer.from(key)
    try {
      // Empty private file initialisation is exclusive; SQLite serialises its own schema/lock.
      try { closeSync(openSync(this.#leasePath, 'wx', 0o600)) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      const leaseFile = this.#privateFile(this.#leasePath)
      this.#leaseInode = leaseFile.ino
      this.#leaseDevice = leaseFile.dev
      this.#lease = new DatabaseSync(this.#leasePath)
      this.#lease.exec('PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS lease (id INTEGER PRIMARY KEY); BEGIN IMMEDIATE;')
      this.#check()
    } catch (error) {
      this.#lease?.close()
      this.#key.fill(0)
      throw error
    }
  }

  #privateFile(path: string) {
    const file = lstatSync(path)
    if (!file.isFile() || file.nlink !== 1 || (file.mode & 0o077) !== 0 || file.uid !== process.getuid?.()) throw new Error('live keeper file is not private and singly linked')
    return file
  }
  #check(): void {
    if (this.#closed) throw new Error('live keeper store is closed')
    const lease = this.#privateFile(this.#leasePath)
    if (lease.ino !== this.#leaseInode || lease.dev !== this.#leaseDevice) throw new Error('live keeper lease file was replaced')
  }

  load(): string | undefined {
    this.#check()
    let fd: number
    try {
      this.#privateFile(this.path)
      fd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    try {
      const file = fstatSync(fd)
      if (!file.isFile() || file.nlink !== 1 || file.size < 29 || file.size > LIMIT + 29) throw new Error('invalid live keeper file size')
      const bytes = readFileSync(fd)
      if (bytes.length !== file.size || bytes[0] !== 1) throw new Error('invalid live keeper file envelope')
      const decipher = createDecipheriv('aes-256-gcm', this.#key, bytes.subarray(1, 13))
      decipher.setAAD(AAD)
      decipher.setAuthTag(bytes.subarray(13, 29))
      const plaintext = Buffer.concat([decipher.update(bytes.subarray(29)), decipher.final()])
      const result = plaintext.toString('utf8')
      if (!Buffer.from(result, 'utf8').equals(plaintext)) throw new Error('invalid live keeper file encoding')
      plaintext.fill(0)
      return result
    } finally { closeSync(fd) }
  }

  save(record: string): void {
    this.#check()
    const plaintext = Buffer.from(record, 'utf8')
    if (plaintext.length > LIMIT) throw new Error('live keeper journal is too large')
    try { this.#privateFile(this.path) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const nonce = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.#key, nonce)
    cipher.setAAD(AAD)
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
    plaintext.fill(0)
    const envelope = Buffer.concat([Buffer.from([1]), nonce, cipher.getAuthTag(), ciphertext])
    const temporary = `${this.path}.${process.pid}.${randomBytes(12).toString('hex')}.tmp`
    let fd: number | undefined
    try {
      fd = openSync(temporary, 'wx', 0o600)
      writeFileSync(fd, envelope)
      fsyncSync(fd)
      closeSync(fd); fd = undefined
      this.#check()
      renameSync(temporary, this.path)
      const parent = openSync(dirname(this.path), constants.O_RDONLY)
      try { fsyncSync(parent) } finally { closeSync(parent) }
    } finally {
      if (fd !== undefined) closeSync(fd)
      try { unlinkSync(temporary) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    try { this.#lease?.close() } finally { this.#key.fill(0); this.#lease = undefined }
  }
}
