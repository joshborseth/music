import { Option } from 'effect'
import { describe, expect, test } from 'vitest'

import {
  TILE_PALETTE,
  isGrey,
  relativeLuminance,
  textToneOn,
  tileColors,
} from './color'

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

describe('tileColors', () => {
  // YouTube Music's moods, in its order, with its colors.
  const moods = [
    '#a4c5ff', // Chill
    '#00a513', // Christmas
    '#ffc200', // Commute
    '#ffe780', // Energize
    '#a4ffa4', // Feel good
    '#cccccc', // Focus
    '#606060', // Gaming
    '#ff8d40', // Halloween
    '#b47bff', // Party
    '#cc0000', // Romance
    '#8c8c8c', // Sad
    '#7b3edb', // Sleep
    '#ff8d40', // Workout
  ].map(Option.some)

  const colors = tileColors(moods, 2)

  test('gives every tile a color, and none of them grey', () => {
    expect(colors).toHaveLength(moods.length)
    expect(colors.filter(isGrey)).toEqual([])
  })

  test("keeps YouTube's distinct colors", () => {
    expect(colors.slice(0, 5)).toEqual([
      '#a4c5ff',
      '#00a513',
      '#ffc200',
      '#ffe780',
      '#a4ffa4',
    ])
    expect(colors[7]).toBe('#ff8d40')
  })

  test('gives a second tile of one color another', () => {
    expect(colors[12]).not.toBe('#ff8d40')
    expect(new Set(colors).size).toBe(colors.length)
  })

  test('never puts two alike colors side by side or one above the other', () => {
    colors.forEach((color, index) => {
      if (index % 2 === 1) {
        expect(color).not.toBe(colors[index - 1])
      }
      if (index >= 2) {
        expect(color).not.toBe(colors[index - 2])
      }
    })
  })

  test('fills tiles with no color from the palette', () => {
    expect(
      tileColors([Option.none(), Option.none(), Option.none()], 2),
    ).toEqual(TILE_PALETTE.slice(0, 3))
  })

  test('keeps text readable on every palette color', () => {
    TILE_PALETTE.forEach(color => {
      const luminance = Option.getOrThrow(relativeLuminance(color))
      const tone = Option.getOrThrow(textToneOn(color))
      const contrast =
        tone === 'Light' ? 1.05 / (luminance + 0.05) : (luminance + 0.05) / 0.05
      expect(contrast).toBeGreaterThanOrEqual(3)
    })
  })
})
