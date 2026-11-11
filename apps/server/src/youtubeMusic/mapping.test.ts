import { describe, expect, test } from 'bun:test'
import { Option } from 'effect'

import { filterSome, toArtwork } from './mapping.ts'

const thumbnail = (url: string, size: number) => ({
  url,
  width: size,
  height: size,
})

describe('toArtwork', () => {
  test('sorts sizes smallest first and adds a large Google variant', () => {
    const artwork = toArtwork([
      thumbnail('https://lh3.googleusercontent.com/abc=w120-h120-l90-rj', 120),
      thumbnail('https://lh3.googleusercontent.com/abc=w60-h60-l90-rj', 60),
    ])

    expect(artwork.map(({ width }) => width)).toEqual([60, 120, 544])
    expect(artwork.at(-1)?.url).toBe(
      'https://lh3.googleusercontent.com/abc=w544-h544-l90-rj',
    )
  })

  test('leaves fixed-size video thumbnails alone', () => {
    const artwork = toArtwork([
      {
        url: 'https://i.ytimg.com/vi/x/hqdefault.jpg',
        width: 480,
        height: 360,
      },
    ])

    expect(artwork).toHaveLength(1)
  })

  test('makes protocol-relative URLs absolute', () => {
    const artwork = toArtwork([thumbnail('//yt3.ggpht.com/photo.jpg', 900)])

    expect(artwork[0]?.url).toBe('https://yt3.ggpht.com/photo.jpg')
  })

  test('treats missing thumbnails as no artwork', () => {
    expect(toArtwork(undefined)).toEqual([])
  })
})

describe('filterSome', () => {
  test('keeps only the present results', () => {
    expect(
      filterSome([1, 2, 3, 4], value =>
        value % 2 === 0 ? Option.some(value * 10) : Option.none(),
      ),
    ).toEqual([20, 40])
  })
})
