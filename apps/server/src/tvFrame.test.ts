import { describe, expect, test } from 'bun:test'

import { PNG_SIGNATURE, encodePng as png } from './testing/png.ts'
import { isBlankFrame } from './tvFrame.ts'

describe('a blank frame from the TV', () => {
  test('is one with every pixel black', () => {
    expect(isBlankFrame(png(16, 12, 4, () => [0, 0, 0, 255]))).toBe(true)
    expect(isBlankFrame(png(16, 12, 3, () => [2, 1, 3]))).toBe(true)
  })

  test('is one with every pixel clear', () => {
    expect(isBlankFrame(png(16, 12, 4, () => [200, 90, 30, 0]))).toBe(true)
  })

  test('is not one that shows anything', () => {
    // One lit pixel, in a row that the Paeth filter wrote.
    expect(
      isBlankFrame(
        png(16, 12, 4, (x, y) =>
          x === 9 && y === 4 ? [0, 180, 60, 255] : [0, 0, 0, 255],
        ),
      ),
    ).toBe(false)
    expect(isBlankFrame(png(16, 12, 3, (x, y) => [x * 10, y * 20, 128]))).toBe(
      false,
    )
  })

  test('is not something it cannot read', () => {
    expect(isBlankFrame(new Uint8Array([...PNG_SIGNATURE, 0]))).toBe(false)
    const truncated = png(4, 4, 4, () => [0, 0, 0, 255]).subarray(0, 40)
    expect(isBlankFrame(truncated)).toBe(false)
  })
})
