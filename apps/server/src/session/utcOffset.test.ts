import { describe, expect, test } from 'bun:test'
import { Option } from 'effect'

import { parseUtcOffset } from './utcOffset.ts'

describe('parseUtcOffset', () => {
  test('reads date +%z output', () => {
    expect(parseUtcOffset('-0700\n')).toEqual(Option.some(-420))
    expect(parseUtcOffset('+0530')).toEqual(Option.some(330))
    expect(parseUtcOffset('+0000')).toEqual(Option.some(0))
  })

  test('rejects anything else', () => {
    expect(parseUtcOffset('')).toEqual(Option.none())
    expect(parseUtcOffset('MST')).toEqual(Option.none())
  })
})
