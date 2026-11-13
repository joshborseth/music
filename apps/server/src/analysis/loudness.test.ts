import { describe, expect, test } from 'bun:test'
import { Option } from 'effect'

import {
  MAX_BOOST_DB,
  gainFor,
  gainFromYouTube,
  measuredLoudness,
  parseEbur128Summary,
} from './loudness.ts'

/** The end of ffmpeg 7's log for `ebur128=peak=true:framelog=verbose`. */
const summary = (integrated: string, peak: string) => `
Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'song.m4a':
  Duration: 00:03:25.19, start: 0.000000, bitrate: 129 kb/s
[Parsed_ebur128_0 @ 0x7fed7c004700] Summary:

  Integrated loudness:
    I:         ${integrated} LUFS
    Threshold: -27.5 LUFS

  Loudness range:
    LRA:         4.1 LU
    Threshold: -37.4 LUFS
    LRA low:   -19.7 LUFS
    LRA high:  -15.6 LUFS

  True peak:
    Peak:       ${peak} dBFS
[out#0/null @ 0x563888900cc0] video:0KiB audio:14676KiB subtitle:0KiB
`

describe("reading ffmpeg's ebur128 summary", () => {
  test('finds the integrated loudness and the true peak', () => {
    expect(parseEbur128Summary(summary('-17.4', '-2.3'))).toEqual(
      Option.some({ integratedLufs: -17.4, truePeakDbtp: -2.3 }),
    )
    expect(parseEbur128Summary(summary('-7.9', '1.2'))).toEqual(
      Option.some({ integratedLufs: -7.9, truePeakDbtp: 1.2 }),
    )
  })

  test("keeps a silent song's missing peak", () => {
    expect(parseEbur128Summary(summary('-70.0', '-inf'))).toEqual(
      Option.some({
        integratedLufs: -70,
        truePeakDbtp: Number.NEGATIVE_INFINITY,
      }),
    )
  })

  test('finds nothing in a log without a summary', () => {
    expect(parseEbur128Summary('ffmpeg exited')).toEqual(Option.none())
  })
})

describe('the Sound Check gain', () => {
  test('brings a loud song down to -14 LUFS, whatever its peaks', () => {
    expect(gainFor({ integratedLufs: -8, truePeakDbtp: 1.5 })).toBe(-6)
  })

  test('brings a quiet song up only as far as its peaks allow', () => {
    // Room for all of it.
    expect(gainFor({ integratedLufs: -18, truePeakDbtp: -8 })).toBe(4)
    // Peaks at -3 dBTP leave 2 dB under the -1 dBTP ceiling.
    expect(gainFor({ integratedLufs: -18, truePeakDbtp: -3 })).toBe(2)
    // Peaks already past the ceiling: left as it is, never turned down.
    expect(gainFor({ integratedLufs: -18, truePeakDbtp: 0.4 })).toBe(0)
  })

  test('never turns a very quiet song up more than the most', () => {
    expect(gainFor({ integratedLufs: -40, truePeakDbtp: -30 })).toBe(
      MAX_BOOST_DB,
    )
  })

  test('leaves silence alone', () => {
    expect(
      gainFor({
        integratedLufs: -70,
        truePeakDbtp: Number.NEGATIVE_INFINITY,
      }),
    ).toBe(0)
  })

  test("from YouTube's figure, only turns songs down", () => {
    expect(gainFromYouTube(-10.36)).toBe(-3.6)
    expect(gainFromYouTube(-17.35)).toBe(0)
  })

  test('says what it was measured from', () => {
    expect(
      measuredLoudness('abc', {
        integratedLufs: -70,
        truePeakDbtp: Number.NEGATIVE_INFINITY,
      }),
    ).toEqual({
      videoId: 'abc',
      gainDb: 0,
      source: 'Measured',
      integratedLufs: -70,
      truePeakDbtp: null,
    })
  })
})
