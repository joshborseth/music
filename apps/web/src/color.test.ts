import { Option } from 'effect'
import { describe, expect, test } from 'vitest'

import { relativeLuminance, textToneOn } from './color'

describe('textToneOn', () => {
  test('puts dark text on light colors and light text on dark ones', () => {
    expect(textToneOn('#ffffff')).toEqual(Option.some('Dark'))
    expect(textToneOn('#f5d000')).toEqual(Option.some('Dark'))
    expect(textToneOn('#22d46f')).toEqual(Option.some('Dark'))
    expect(textToneOn('#000000')).toEqual(Option.some('Light'))
    expect(textToneOn('#1e3a8a')).toEqual(Option.some('Light'))
    expect(textToneOn('#d32f2f')).toEqual(Option.some('Light'))
  })

  test('keeps white text on strong mid-tones, as music apps do', () => {
    expect(textToneOn('#3b82f6')).toEqual(Option.some('Light'))
    expect(textToneOn('#0a9a0a')).toEqual(Option.some('Light'))
  })

  test('reads upper-case hex', () => {
    expect(textToneOn('#FFFFFF')).toEqual(Option.some('Dark'))
  })

  test('has no answer for anything but #rrggbb', () => {
    expect(textToneOn('red')).toEqual(Option.none())
    expect(textToneOn('#fff')).toEqual(Option.none())
  })
})

describe('relativeLuminance', () => {
  test('runs from 0 for black to 1 for white', () => {
    expect(relativeLuminance('#000000')).toEqual(Option.some(0))
    expect(relativeLuminance('#ffffff')).toEqual(Option.some(1))
  })
})
