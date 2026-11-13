import { describe, expect, test } from 'bun:test'

import { isNotFound } from './service.ts'

describe('not found', () => {
  test.each([
    // An album id of the wrong shape, as youtubei.js says it.
    'Invalid album id',
    'Invalid artist id',
    // A well-formed id that points at nothing.
    'No contents found in the response',
    'Music queue was empty, the given id is probably invalid.',
  ])('“%s” means there is nothing there', message => {
    expect(isNotFound(new Error(message))).toBe(true)
  })

  test('a failed request means YouTube Music did not answer', () => {
    expect(isNotFound(new Error('fetch failed'))).toBe(false)
    expect(isNotFound(new Error('Unexpected response'))).toBe(false)
  })
})
