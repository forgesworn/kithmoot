import { describe, expect, it } from 'vitest'
import { SCREEN_PERMISSION_ADVICE, describeShareError, isSystemRefusal } from './share-error.js'

function named(name: string, message: string): Error {
  const err = new Error(message)
  err.name = name
  return err
}

describe('describeShareError', () => {
  it('turns the raw capture-constraints message into the permission steps and keeps the raw words', () => {
    const text = describeShareError(named('NotReadableError', 'Invalid capture constraints'))
    expect(text.plain).toBe(SCREEN_PERMISSION_ADVICE)
    expect(text.raw).toBe('Invalid capture constraints')
  })

  it('treats a refusal by the system as the same thing', () => {
    expect(isSystemRefusal(named('NotAllowedError', 'Permission denied by system'))).toBe(true)
  })

  it('leaves the person pressing Cancel alone', () => {
    const err = named('NotAllowedError', 'Permission denied')
    expect(isSystemRefusal(err)).toBe(false)
    expect(describeShareError(err)).toEqual({ plain: 'Permission denied', raw: '' })
  })

  it('copes with a DOMException-like object and a bare string', () => {
    expect(describeShareError({ name: 'AbortError', message: 'Invalid capture constraints' }).plain).toBe(SCREEN_PERMISSION_ADVICE)
    expect(describeShareError('something else')).toEqual({ plain: 'something else', raw: '' })
  })
})
