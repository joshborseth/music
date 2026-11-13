import { Option, Schema } from 'effect'

import type { Tv } from '@music/shared'

/*
 * Sound Check: how loud each song is, and the gain that brings it to the
 * same loudness as every other. ffmpeg's `ebur128` filter measures the
 * song's integrated loudness (EBU R128, in LUFS) and its true peak (the
 * highest the waveform reaches between samples, in dBTP) while the song is
 * decoded for its analysis. Players add the gain; the server only measures.
 */

/** Spotify's and YouTube's level: every song plays at about this loudness. */
export const TARGET_LUFS = -14
/** A song is turned up only as far as keeps its true peak under this. */
export const PEAK_CEILING_DBTP = -1
/** The most a quiet song is turned up, whatever its peaks allow. */
export const MAX_BOOST_DB = 10
/** The most a loud song is turned down. */
export const MAX_CUT_DB = 20
/** Quieter than this is near silence (ebur128 says -70): left alone. */
const SILENT_LUFS = -60

export const Loudness = Schema.Struct({
  integratedLufs: Schema.Number,
  truePeakDbtp: Schema.Number,
})
export type Loudness = typeof Loudness.Type

const round1 = (value: number): number => Math.round(value * 10) / 10

const clampGain = (db: number): number =>
  round1(Math.min(MAX_BOOST_DB, Math.max(-MAX_CUT_DB, db)))

/**
 * The gain that brings a measured song to `TARGET_LUFS`. A loud song is
 * turned down all the way; a quiet one is turned up only while its true
 * peak stays under `PEAK_CEILING_DBTP`, so the gain never makes it clip,
 * and never turned down for its peaks alone.
 */
export const gainFor = ({ integratedLufs, truePeakDbtp }: Loudness): number => {
  if (!(integratedLufs > SILENT_LUFS)) return 0
  const wanted = TARGET_LUFS - integratedLufs
  if (wanted <= 0) return clampGain(wanted)
  const headroom = Number.isFinite(truePeakDbtp)
    ? Math.max(0, PEAK_CEILING_DBTP - truePeakDbtp)
    : wanted
  return clampGain(Math.min(wanted, headroom))
}

/**
 * The gain from YouTube's own loudness figure for the song (its integrated
 * loudness in LUFS). It says nothing about peaks, so it only ever turns a
 * song down.
 */
export const gainFromYouTube = (youTubeLufs: number): number =>
  clampGain(Math.min(0, TARGET_LUFS - youTubeLufs))

/** What `/tv/loudness` answers for a measured song. */
export const measuredLoudness = (
  videoId: string,
  loudness: Loudness,
): Tv.TvLoudness => ({
  videoId,
  gainDb: gainFor(loudness),
  source: 'Measured',
  integratedLufs: loudness.integratedLufs,
  truePeakDbtp: Number.isFinite(loudness.truePeakDbtp)
    ? loudness.truePeakDbtp
    : null,
})

// FFMPEG

/**
 * The `ebur128` filter as the decode runs it: with true peak, and with its
 * per-frame lines lowered to verbose, so at ffmpeg's `info` level it logs
 * only its summary.
 */
export const EBUR128_FILTER = 'ebur128=peak=true:framelog=verbose'

const NUMBER = String.raw`(-?(?:\d+(?:\.\d+)?|inf))`
const INTEGRATED = new RegExp(String.raw`^\s*I:\s+${NUMBER} LUFS`, 'm')
const TRUE_PEAK = new RegExp(
  String.raw`True peak:\s*\n\s*Peak:\s+${NUMBER} dBFS`,
  'm',
)

const toNumber = (text: string): number =>
  text === 'inf' ? Infinity : text === '-inf' ? -Infinity : Number(text)

/**
 * The loudness in ffmpeg's log (its stderr) from `EBUR128_FILTER`, read
 * from the filter's summary. A silent song's peak is `-inf`, kept as such.
 */
export const parseEbur128Summary = (log: string): Option.Option<Loudness> => {
  const summary = log.slice(log.lastIndexOf('Summary:'))
  const integrated = INTEGRATED.exec(summary)?.[1]
  const peak = TRUE_PEAK.exec(summary)?.[1]
  if (integrated === undefined || peak === undefined) return Option.none()
  const integratedLufs = toNumber(integrated)
  const truePeakDbtp = toNumber(peak)
  return Number.isFinite(integratedLufs) && !Number.isNaN(truePeakDbtp)
    ? Option.some({ integratedLufs, truePeakDbtp })
    : Option.none()
}
