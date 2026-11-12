/*
 * A radix-2 FFT for real input, sized once and reused for every frame. A
 * real signal of length n runs as a complex FFT of length n/2 (even samples
 * as the real part, odd samples as the imaginary part), then one pass splits
 * the halves apart, which takes about half the time of a full complex FFT.
 */

export interface RealFft {
  readonly size: number
  /**
   * The power (squared magnitude) of bins 0 through size/2 of `input`'s
   * spectrum, written into `power` (length size/2 + 1).
   */
  readonly powerSpectrum: (input: Float64Array, power: Float64Array) => void
}

const isPowerOfTwo = (n: number): boolean => n >= 4 && (n & (n - 1)) === 0

export const makeRealFft = (size: number): RealFft => {
  if (!isPowerOfTwo(size)) {
    throw new RangeError(`FFT size must be a power of two, got ${size}`)
  }
  const half = size / 2
  const bits = Math.log2(half)

  const reverse = new Uint32Array(half)
  for (let i = 0; i < half; i++) {
    let r = 0
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b)
    reverse[i] = r
  }
  // Twiddles for the half-size complex FFT, and for the final split.
  const cosHalf = new Float64Array(half / 2)
  const sinHalf = new Float64Array(half / 2)
  for (let k = 0; k < half / 2; k++) {
    cosHalf[k] = Math.cos((2 * Math.PI * k) / half)
    sinHalf[k] = Math.sin((2 * Math.PI * k) / half)
  }
  const cosFull = new Float64Array(half + 1)
  const sinFull = new Float64Array(half + 1)
  for (let k = 0; k <= half; k++) {
    cosFull[k] = Math.cos((2 * Math.PI * k) / size)
    sinFull[k] = Math.sin((2 * Math.PI * k) / size)
  }
  const re = new Float64Array(half)
  const im = new Float64Array(half)

  const powerSpectrum = (input: Float64Array, power: Float64Array): void => {
    for (let i = 0; i < half; i++) {
      const j = reverse[i] ?? 0
      re[j] = input[2 * i] ?? 0
      im[j] = input[2 * i + 1] ?? 0
    }
    for (let length = 2; length <= half; length *= 2) {
      const step = half / length
      const halfLength = length / 2
      for (let start = 0; start < half; start += length) {
        for (let k = 0; k < halfLength; k++) {
          const wr = cosHalf[k * step] ?? 0
          const wi = -(sinHalf[k * step] ?? 0)
          const a = start + k
          const b = a + halfLength
          const br = re[b] ?? 0
          const bi = im[b] ?? 0
          const tr = br * wr - bi * wi
          const ti = br * wi + bi * wr
          const ar = re[a] ?? 0
          const ai = im[a] ?? 0
          re[b] = ar - tr
          im[b] = ai - ti
          re[a] = ar + tr
          im[a] = ai + ti
        }
      }
    }
    for (let k = 0; k <= half; k++) {
      const zr = re[k % half] ?? 0
      const zi = im[k % half] ?? 0
      const mr = re[(half - k) % half] ?? 0
      const mi = im[(half - k) % half] ?? 0
      // Even part (Z[k] + conj Z[n/2-k]) / 2, odd part (Z[k] - conj Z[n/2-k]) / 2i.
      const er = (zr + mr) / 2
      const ei = (zi - mi) / 2
      const or = (zi + mi) / 2
      const oi = -(zr - mr) / 2
      const c = cosFull[k] ?? 0
      const s = sinFull[k] ?? 0
      const xr = er + c * or + s * oi
      const xi = ei + c * oi - s * or
      power[k] = xr * xr + xi * xi
    }
  }

  return { size, powerSpectrum }
}
