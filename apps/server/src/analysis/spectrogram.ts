import { makeRealFft } from './fft.ts'

/*
 * The song as frames: a short-time Fourier transform (Hann window of 2048
 * samples, a frame every 512, centered like librosa's), reduced per frame
 * to what the rest of the analysis reads: a log-mel spectrum, a chroma
 * vector (energy per pitch class), and the loudness of the frame's hop.
 */

export const FFT_SIZE = 2048
export const HOP = 512
export const MEL_BANDS = 96
const MEL_MIN_HZ = 30
/** Quieter than this many dB under the song's loudest bin counts as silence. */
const TOP_DB = 80
const CHROMA_MIN_HZ = 65
const CHROMA_MAX_HZ = 4200

export interface Spectrogram {
  readonly sampleRate: number
  readonly frames: number
  /** Frames per second. */
  readonly frameRate: number
  /** `frames × MEL_BANDS` power in dB, floored `TOP_DB` under the loudest. */
  readonly melDb: Float32Array
  /** `frames × 12` spectral power per pitch class. */
  readonly chroma: Float32Array
  /** Mean square of the samples in each frame's hop. */
  readonly power: Float32Array
  /** The center frequency of each mel band, in Hz. */
  readonly melHz: Float64Array
}

const hzToMel = (hz: number): number => 2595 * Math.log10(1 + hz / 700)
const melToHz = (mel: number): number => 700 * (10 ** (mel / 2595) - 1)

interface Band {
  readonly firstBin: number
  readonly weights: Float64Array
}

/** Triangular mel filters over the FFT bins; a band too narrow for any bin takes its nearest one. */
const melFilters = (
  sampleRate: number,
): { bands: ReadonlyArray<Band>; centers: Float64Array } => {
  const binHz = sampleRate / FFT_SIZE
  const lastBin = FFT_SIZE / 2
  const minMel = hzToMel(MEL_MIN_HZ)
  const maxMel = hzToMel(sampleRate / 2)
  const edges = Array.from({ length: MEL_BANDS + 2 }, (_, i) =>
    melToHz(minMel + ((maxMel - minMel) * i) / (MEL_BANDS + 1)),
  )
  const centers = new Float64Array(MEL_BANDS)
  const bands = Array.from({ length: MEL_BANDS }, (_, band): Band => {
    const low = edges[band] ?? 0
    const center = edges[band + 1] ?? 0
    const high = edges[band + 2] ?? 0
    centers[band] = center
    const firstBin = Math.max(0, Math.ceil(low / binHz))
    const endBin = Math.min(lastBin, Math.floor(high / binHz))
    const weights: Array<number> = []
    for (let bin = firstBin; bin <= endBin; bin++) {
      const hz = bin * binHz
      const weight =
        hz <= center
          ? (hz - low) / (center - low)
          : (high - hz) / (high - center)
      weights.push(Math.max(0, weight))
    }
    if (weights.every(weight => weight === 0)) {
      return {
        firstBin: Math.min(lastBin, Math.round(center / binHz)),
        weights: Float64Array.of(1),
      }
    }
    return { firstBin, weights: Float64Array.from(weights) }
  })
  return { bands, centers }
}

/** The pitch class (0 = C) of each FFT bin in the chroma range, or -1 outside it. */
const chromaClasses = (sampleRate: number): Int8Array => {
  const binHz = sampleRate / FFT_SIZE
  return Int8Array.from({ length: FFT_SIZE / 2 + 1 }, (_, bin) => {
    const hz = bin * binHz
    if (hz < CHROMA_MIN_HZ || hz > CHROMA_MAX_HZ) return -1
    const midi = Math.round(69 + 12 * Math.log2(hz / 440))
    return ((midi % 12) + 12) % 12
  })
}

export const spectrogram = (
  samples: Float32Array,
  sampleRate: number,
): Spectrogram => {
  const fft = makeRealFft(FFT_SIZE)
  const bins = FFT_SIZE / 2 + 1
  const frames = Math.floor(samples.length / HOP) + 1
  const pad = FFT_SIZE / 2
  const window = Float64Array.from(
    { length: FFT_SIZE },
    (_, n) => 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / FFT_SIZE),
  )
  const { bands, centers } = melFilters(sampleRate)
  const classes = chromaClasses(sampleRate)

  const frame = new Float64Array(FFT_SIZE)
  const spectrum = new Float64Array(bins)
  const melDb = new Float32Array(frames * MEL_BANDS)
  const chroma = new Float32Array(frames * 12)
  const power = new Float32Array(frames)
  let loudest = -Infinity

  for (let t = 0; t < frames; t++) {
    const start = t * HOP - pad
    for (let n = 0; n < FFT_SIZE; n++) {
      const i = start + n
      frame[n] =
        i >= 0 && i < samples.length ? (samples[i] ?? 0) * (window[n] ?? 0) : 0
    }
    fft.powerSpectrum(frame, spectrum)

    for (let band = 0; band < MEL_BANDS; band++) {
      const filter = bands[band]
      if (filter === undefined) continue
      let sum = 0
      for (let w = 0; w < filter.weights.length; w++) {
        sum += (filter.weights[w] ?? 0) * (spectrum[filter.firstBin + w] ?? 0)
      }
      const db = 10 * Math.log10(Math.max(sum, 1e-10))
      melDb[t * MEL_BANDS + band] = db
      if (db > loudest) loudest = db
    }

    for (let bin = 0; bin < bins; bin++) {
      const pitchClass = classes[bin] ?? -1
      if (pitchClass >= 0) {
        const at = t * 12 + pitchClass
        chroma[at] = (chroma[at] ?? 0) + (spectrum[bin] ?? 0)
      }
    }

    const hopStart = Math.max(0, t * HOP - HOP / 2)
    const hopEnd = Math.min(samples.length, t * HOP + HOP / 2)
    let squares = 0
    for (let i = hopStart; i < hopEnd; i++) {
      const sample = samples[i] ?? 0
      squares += sample * sample
    }
    power[t] = hopEnd > hopStart ? squares / (hopEnd - hopStart) : 0
  }

  const floor = loudest - TOP_DB
  for (let i = 0; i < melDb.length; i++) {
    if ((melDb[i] ?? 0) < floor) melDb[i] = floor
  }

  return {
    sampleRate,
    frames,
    frameRate: sampleRate / HOP,
    melDb,
    chroma,
    power,
    melHz: centers,
  }
}

/** The mel bands whose centers fall in `[lowHz, highHz)`. */
export const bandsBetween = (
  spec: Spectrogram,
  lowHz: number,
  highHz: number,
): { readonly from: number; readonly to: number } => {
  let from = MEL_BANDS
  let to = 0
  spec.melHz.forEach((hz, band) => {
    if (hz >= lowHz && hz < highHz) {
      from = Math.min(from, band)
      to = Math.max(to, band + 1)
    }
  })
  return from < to ? { from, to } : { from: 0, to: MEL_BANDS }
}
