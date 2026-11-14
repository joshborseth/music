/*
 * The visuals lab: the TV's shaders and render passes, driven by a made-up
 * song (or a real audio file), so scenes can be tuned in a browser.
 *
 * The passes match `apps/tv/src/visuals/gpu.rs`: each scene draws into its
 * own pair of textures (feedback), Terrain adding its land as a mesh on
 * top, the bright parts are cut out at an eighth of the scenes' size and
 * blurred there in one pass (the glow), `final.glsl` puts it all together
 * at the scenes' size under the app's shade, and `present.glsl` stretches
 * that to the screen with a fine grain. While one scene dissolves into the
 * next, only the one coming in draws, and `final.glsl` destroys the
 * other's frozen last frame (moments.ts). The per-frame values in `motion`
 * and `screenLook` (moments.ts) match `motion.rs`.
 */

import {
  type Cues,
  type SceneChange,
  TRANSITIONS,
  buildAndLanding,
  hit,
  madeUpCues,
  momentsPage,
  screenLook,
  transitionCode,
} from './moments.ts'

declare const SHADERS: Readonly<Record<string, string>>
declare const MODE: string

interface SceneDef {
  readonly name: string
  readonly file: string
  /** The land drawn as a mesh on top (terrain.vert). */
  readonly land: boolean
}

const SCENES: ReadonlyArray<SceneDef> = [
  { name: 'Silk', file: 'silk.glsl', land: false },
  { name: 'Ink', file: 'ink.glsl', land: false },
  { name: 'Terrain', file: 'terrain.glsl', land: true },
  { name: 'Halo', file: 'halo.glsl', land: false },
  { name: 'Tunnel', file: 'tunnel.glsl', land: false },
  { name: 'Aurora', file: 'aurora.glsl', land: false },
  { name: 'Stars', file: 'stars.glsl', land: false },
]

const BANDS = 48
const HISTORY_ROWS = 128
const HISTORY_RATE = 32
const WAVE = 512
/** The song's score around now (music.rs, `SCORE_COLUMNS` × `AHEAD_ROWS`). */
const SCORE_COLUMNS = 32
const AHEAD_ROWS = 128
const AHEAD_BEHIND = 8
const SCORE_RATE = 20
const COVER = 256
/**
 * Terrain's mesh: a column on each band, the road and its edge, and five
 * far columns, each side; a row for each history row and the far edge.
 * Drawn as one triangle strip a pair of rows, joined by empty triangles:
 * the TV's `LAND_VERTICES`, worked out the same way as `terrain.vert`.
 */
const LAND_COLUMNS = 2 * (1 + BANDS + 5) + 1
const LAND_VERTICES = HISTORY_ROWS * (2 * LAND_COLUMNS + 2) - 2
/** The glow is this many times smaller than the scenes, each way (gpu.rs). */
const BLOOM_DIVISOR = 8

/** One of a frame's passes, which the bench times alone. */
type Pass = 'scene' | 'bloom' | 'final' | 'present'

// MUSIC ----------------------------------------------------------------

/** What the server's analysis tells apart: the TV's `music::Parts`. */
interface Parts {
  snare: number
  hat: number
  drums: number
  lead: number
  melody: number
  bass: number
  brightness: number
  turn: number
  minor: number
  chordChange: number
  stop: number
  riser: number
  fill: number
  repeat: number
}

const NO_PARTS: Parts = {
  snare: 0,
  hat: 0,
  drums: 0,
  lead: 0,
  melody: 0,
  bass: 0,
  brightness: 0,
  turn: 0,
  minor: 0,
  chordChange: 0,
  stop: 0,
  riser: 0,
  fill: 0,
  repeat: 0,
}

/** The score around now, as the TV's `Listener` keeps it for the GPU. */
interface Ahead {
  rows: Uint8Array
  shift: number
  rate: number
}

interface Music {
  time: number
  beatSeconds: number
  parts: Parts
  ahead?: Ahead
  drive: number
  beats: number
  bar: number
  beatPulse: number
  barPulse: number
  kick: number
  accent: number
  bands: [number, number, number, number]
  levels: Array<number>
  energy: number
  tension: number
  drop: number
  intensity: number
  spectrum: Float32Array
  wave: Float32Array
  section: string
  /**
   * From a real song (the song page): the history rows the TV added this
   * frame, and how far toward the next it is. Without them, the lab keeps
   * its own history at the TV's rate.
   */
  rows?: number
  historyAge?: number
  /** The song's ceiling and its choreography this frame (moments.ts). */
  ceiling?: number
  cue?: Cues
}

const fract = (x: number): number => x - Math.floor(x)
const clamp01 = (x: number): number => Math.min(1, Math.max(0, x))

// MOTION ------------------------------------------------------------------

/** A well-mixed 32-bit hash: the TV's `motion::hash`. */
const hash = (input: number): number => {
  let x = input >>> 0
  x ^= x >>> 16
  x = Math.imul(x, 0x7feb352d)
  x ^= x >>> 15
  x = Math.imul(x, 0x846ca68b)
  x ^= x >>> 16
  return x >>> 0
}

/** 0 to 1 from a hash. */
const unit = (x: number): number => (hash(x) >>> 8) / (1 << 24)

/** Smooth noise along a line, 0 to 1, eased between whole numbers. */
const smoothNoise = (x: number): number => {
  const i = Math.floor(x)
  const f = x - i
  const u = f * f * (3 - 2 * f)
  const a = unit(i >>> 0)
  const b = unit((i + 1) >>> 0)
  return a + (b - a) * u
}

interface Motion {
  readonly pour: Array<number>
  readonly turn: [number, number, number, number]
  readonly flight: [number, number, number, number]
  readonly shake: [number, number]
}

/**
 * What a scene would otherwise work out at every pixel, once a frame: the
 * TV's `Motion::new`. Keep the two in step.
 */
const motion = (music: Music, seed: number): Motion => {
  const drive = music.drive
  const pour: Array<number> = []
  for (let i = 0; i < 3; i++) {
    const phase = drive * (0.21 + 0.07 * i) + i * 2.1 + seed * 5
    const level = music.bands[i] ?? 0
    const first = i === 0 ? 1 : 0
    const parts = music.parts
    const lifted = i === 1 ? 0.25 * (parts.melody - 0.5) * parts.lead : 0
    const hits = i === 1 ? 0.25 * parts.snare : i === 2 ? 0.2 * parts.hat : 0
    pour.push(
      0.55 * Math.sin(phase * 1.3),
      0.32 * Math.cos(phase) + lifted,
      0.025 + 0.05 * level + 0.06 * music.beatPulse * first,
      0.02 + 0.22 * level + 0.35 * music.kick * first + hits,
    )
  }

  const spin = drive * 0.05 + 0.15 * Math.sin(music.beats * Math.PI * 0.25)
  const bob = 0.04 * music.beatPulse * music.energy - 0.12 * music.drop
  const roll = 0.04 * Math.sin(drive * 0.09)
  const [build, land] = buildAndLanding(music)
  const shake =
    music.tension * music.tension * 0.006 +
    music.parts.fill * 0.003 * (0.5 + music.parts.snare) +
    build * build * 0.012 +
    land * land * 0.014
  return {
    pour,
    turn: [
      Math.sin(drive * 0.23) * 0.08,
      Math.cos(drive * 0.17) * 0.08,
      Math.cos(spin),
      Math.sin(spin),
    ],
    flight: [
      0.12 * Math.sin(drive * 0.11),
      0.62 + bob + 0.15 * music.tension,
      Math.cos(roll),
      Math.sin(roll),
    ],
    shake: [
      (smoothNoise(music.time * 23) - 0.5) * shake,
      (smoothNoise(music.time * 27 + 57) - 0.5) * shake,
    ],
  }
}

/**
 * A made-up song at `bpm`, 32 bars round: intro, verse, a four-bar build,
 * the drop, a breakdown.
 */
const madeUpSong = (bpm: number) => {
  let drive = 0
  let lastTime = 0
  const spectrum = new Float32Array(BANDS)
  const wave = new Float32Array(WAVE)
  let seed = 12345
  const random = (): number => {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    return ((seed >>> 0) % 100000) / 100000
  }
  return (time: number): Music => {
    const dt = Math.max(0, time - lastTime)
    lastTime = time
    const beatSeconds = 60 / bpm
    const beats = time / beatSeconds
    const barIndex = Math.floor(beats / 4) % 32
    const sinceBeat = fract(beats) * beatSeconds
    const sinceBar = fract(beats / 4) * beatSeconds * 4
    let energy = 0.3
    let section = 'Intro'
    let tension = 0
    let drop = 0
    if (barIndex >= 8 && barIndex < 16) {
      energy = 0.55
      section = 'Verse'
    } else if (barIndex >= 16 && barIndex < 20) {
      const into = (beats / 4 - Math.floor(beats / 128) * 32 - 16) / 4
      energy = 0.5 + 0.2 * into
      tension = into * into
      section = 'Build'
    } else if (barIndex >= 20 && barIndex < 28) {
      energy = 1
      section = 'Drop'
      const sinceDrop =
        (beats / 4 - Math.floor(beats / 128) * 32 - 20) * 4 * beatSeconds
      drop = Math.exp(-sinceDrop / (beatSeconds * 4))
    } else if (barIndex >= 28) {
      energy = 0.25
      section = 'Breakdown'
    }
    const kicking =
      energy > 0.4 && section !== 'Build' ? 1 : section === 'Build' ? 1 : 0
    const kick = kicking * Math.exp(-sinceBeat * 12)
    const offbeat = Math.exp(-Math.abs(fract(beats) - 0.5) * beatSeconds * 30)
    const snare = Math.floor(beats) % 2 === 1 ? kick : 0
    const bass = clamp01(0.25 + 0.65 * kick * energy + 0.1 * energy)
    const mid = clamp01(
      0.2 + 0.5 * energy + 0.2 * snare + 0.08 * Math.sin(time * 3),
    )
    const treble = clamp01(0.1 + 0.4 * offbeat * energy + 0.2 * energy)
    for (let i = 0; i < BANDS; i++) {
      const x = i / BANDS
      const target = clamp01(
        bass * Math.exp(-x * 9) * 1.1 +
          mid * Math.exp(-Math.pow((x - 0.4) / 0.25, 2)) * 0.8 +
          treble * Math.exp(-Math.pow((x - 0.8) / 0.2, 2)) * 0.7 +
          (random() - 0.5) * 0.12 * energy,
      )
      spectrum[i] =
        target > (spectrum[i] ?? 0)
          ? target
          : (spectrum[i] ?? 0) * 0.86 + target * 0.14
    }
    for (let i = 0; i < WAVE; i++) {
      const s = i / 44100
      wave[i] =
        0.5 * kick * Math.sin(2 * Math.PI * 55 * (s + time)) +
        0.25 * energy * Math.sin(2 * Math.PI * 220 * (s + time)) +
        0.15 * energy * Math.sin(2 * Math.PI * 330 * (s + time) + 1) +
        (random() - 0.5) * 0.2 * treble
    }
    const level = bass * 0.45 + mid * 0.35 + treble * 0.2
    drive += dt * (0.4 + level * 1.6 + kick * 0.6)
    const levels: Array<number> = []
    for (let i = 0; i < 8; i++) {
      let sum = 0
      for (let j = 0; j < BANDS / 8; j++)
        sum += spectrum[i * (BANDS / 8) + j] ?? 0
      levels.push(sum / (BANDS / 8))
    }
    // The score a made-up server would send: the same song, ahead.
    const rows = new Uint8Array(SCORE_COLUMNS * AHEAD_ROWS)
    const position = time * SCORE_RATE
    const firstRow = Math.floor(position) - AHEAD_BEHIND
    for (let r = 0; r < AHEAD_ROWS; r++) {
      const at = (firstRow + r) / SCORE_RATE
      const b = at / beatSeconds
      const bar = Math.floor(b / 4) % 32
      const e = bar >= 20 && bar < 28 ? 1 : bar >= 8 && bar < 20 ? 0.55 : 0.3
      const since = fract(b) * beatSeconds
      const k = e > 0.4 ? Math.exp(-since / 0.12) : 0
      const s = Math.floor(b) % 2 === 1 ? k : 0
      const h =
        e > 0.4 ? Math.exp((-Math.abs(fract(b) - 0.5) * beatSeconds) / 0.12) : 0
      const row = rows.subarray(r * SCORE_COLUMNS, (r + 1) * SCORE_COLUMNS)
      for (let c = 0; c < 24; c++) {
        const x = c / 24
        row[c] = Math.round(
          255 *
            clamp01(
              (0.3 + 0.6 * k) * e * Math.exp(-x * 6) +
                0.4 * e * Math.exp(-(((x - 0.45) / 0.2) ** 2)) +
                0.3 * h * Math.exp(-(((x - 0.85) / 0.15) ** 2)),
            ),
        )
      }
      const melody = 0.5 + 0.4 * Math.sin(b * 0.7)
      ;[
        e,
        k,
        s,
        h,
        0.3 + 0.5 * k * e,
        e > 0.4 ? 0.8 : 0,
        e > 0.4 ? melody : 0,
        0.3 + 0.4 * e,
      ].forEach((value, i) => {
        row[24 + i] = Math.round(255 * clamp01(value))
      })
    }
    const melodyNow = 0.5 + 0.4 * Math.sin(beats * 0.7)
    const { cue, fill } = madeUpCues(beats, beatSeconds)
    return {
      ceiling: 1,
      cue,
      time,
      beatSeconds,
      parts: {
        ...NO_PARTS,
        snare,
        hat: kicking * offbeat,
        drums: 1,
        lead: energy > 0.4 ? 0.8 : 0,
        melody: melodyNow,
        bass,
        brightness: 0.3 + 0.4 * energy,
        turn: barIndex >= 20 && barIndex < 28 ? 40 / 360 : 0,
        chordChange: Math.exp(-sinceBar * 4),
        riser: section === 'Build' ? tension : 0,
        fill,
      },
      ahead: { rows, shift: fract(position), rate: SCORE_RATE },
      drive,
      beats,
      bar: fract(beats / 4),
      beatPulse: Math.exp(-sinceBeat * 9),
      barPulse: Math.exp(-sinceBar * 5),
      kick,
      accent: snare,
      bands: [bass, mid, treble, level],
      levels,
      energy,
      tension,
      drop,
      intensity: energy,
      spectrum,
      wave,
      section,
    }
  }
}

// COVER -----------------------------------------------------------------

/** Some made-up cover art, so the cover scenes have something to show. */
const madeUpCover = (): HTMLCanvasElement => {
  const canvas = document.createElement('canvas')
  canvas.width = COVER
  canvas.height = COVER
  const context = canvas.getContext('2d')
  if (context === null) return canvas
  const gradient = context.createLinearGradient(0, 0, COVER, COVER)
  gradient.addColorStop(0, '#ff3d7f')
  gradient.addColorStop(0.5, '#7b2ff7')
  gradient.addColorStop(1, '#0c1445')
  context.fillStyle = gradient
  context.fillRect(0, 0, COVER, COVER)
  context.fillStyle = '#ffd23f'
  context.beginPath()
  context.arc(COVER * 0.62, COVER * 0.38, COVER * 0.2, 0, Math.PI * 2)
  context.fill()
  context.fillStyle = '#00e5c3'
  context.fillRect(COVER * 0.1, COVER * 0.7, COVER * 0.8, COVER * 0.06)
  context.fillStyle = '#ffffff'
  context.font = `bold ${COVER * 0.14}px system-ui`
  context.fillText('MUSIC', COVER * 0.1, COVER * 0.92)
  return canvas
}

type Rgb = [number, number, number]

const hsvToRgb = (hue: number, sat: number, value: number): Rgb => {
  const channel = (n: number) => {
    const k = (((n + hue * 6) % 6) + 6) % 6
    return value - value * sat * Math.min(1, Math.max(0, Math.min(k, 4 - k)))
  }
  return [channel(5), channel(3), channel(1)]
}

const rgbToHsv = ([red, green, blue]: Rgb): Rgb => {
  const max = Math.max(red, green, blue)
  const chroma = max - Math.min(red, green, blue)
  if (chroma <= 0) return [0, 0, max]
  const hue =
    max === red
      ? ((((green - blue) / chroma) % 6) + 6) % 6
      : max === green
        ? (blue - red) / chroma + 2
        : (red - green) / chroma + 4
  return [hue / 6, chroma / max, max]
}

/** `color` turned round the wheel and deepened: the TV's `look::turned`. */
const turned = (color: Rgb, turns: number, deeper: number): Rgb => {
  if (turns === 0 && deeper === 0) return color
  const [hue, sat, value] = rgbToHsv(color)
  return hsvToRgb((((hue + turns) % 1) + 1) % 1, sat, value * (1 - deeper))
}

/**
 * The cover's strong color in three shades, then its second color, like
 * `look.rs` (`cover_colors`): the hue that covers the most of it, averaged
 * from its own pixels, at full brightness and at least 0.9 saturation; a
 * little deeper, and deep; then the next heaviest hue at least 60° away,
 * when the cover holds at least 12% as much of it, or else the strong
 * color's neighbor 40° round the wheel, at 0.75 saturation.
 */
const strongColors = (pixels: Uint8ClampedArray): Array<Rgb> => {
  const hues = 24
  const bucketOf = (hue: number) => Math.min(hues - 1, Math.floor(hue * hues))
  const colorful: Array<{ hue: number; sat: number; strength: number }> = []
  const weight = new Array<number>(hues).fill(0)
  for (let i = 0; i < pixels.length; i += 4) {
    const r = (pixels[i] ?? 0) / 255
    const g = (pixels[i + 1] ?? 0) / 255
    const b = (pixels[i + 2] ?? 0) / 255
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    const sat = max === 0 ? 0 : (max - min) / max
    if (sat < 0.25 || max < 0.2) continue
    let hue = 0
    if (max === r) hue = ((g - b) / (max - min) + 6) % 6
    else if (max === g) hue = (b - r) / (max - min) + 2
    else hue = (r - g) / (max - min) + 4
    hue /= 6
    colorful.push({ hue, sat, strength: sat * max })
    const bucket = bucketOf(hue)
    weight[bucket] = (weight[bucket] ?? 0) + sat * max
  }
  const total = weight.reduce((sum, w) => sum + w, 0)
  const withSecond = (strong: Rgb, second: Rgb): Array<Rgb> => {
    const shade = (k: number): Rgb => [
      strong[0] * k,
      strong[1] * k,
      strong[2] * k,
    ]
    return [shade(1), shade(0.75), shade(0.5), second]
  }
  if (total < (pixels.length / 4) * 0.01) {
    return withSecond([0.13, 0.83, 0.44], [0.15, 0.85, 0.95])
  }
  const around = (center: number) =>
    [0, 1, 2].map(step => (center + hues - 1 + step) % hues)
  const run = (center: number) =>
    around(center).reduce((sum, b) => sum + (weight[b] ?? 0), 0)
  const heaviest = (candidates: ReadonlyArray<number>): number | undefined =>
    candidates.reduce<number | undefined>(
      (best, b) => (best === undefined || run(b) >= run(best) ? b : best),
      undefined,
    )
  const all = Array.from({ length: hues }, (_, b) => b)
  const peak = heaviest(all) ?? 0
  const strong = (center: number): [number, number] => {
    const near = around(center)
    let x = 0
    let y = 0
    let satSum = 0
    let sum = 0
    for (const pixel of colorful) {
      if (!near.includes(bucketOf(pixel.hue))) continue
      const angle = pixel.hue * Math.PI * 2
      x += Math.cos(angle) * pixel.strength
      y += Math.sin(angle) * pixel.strength
      satSum += pixel.sat * pixel.strength
      sum += pixel.strength
    }
    const hue = (((Math.atan2(y, x) / (Math.PI * 2)) % 1) + 1) % 1
    const sat = Math.min(1, Math.max(0.9, satSum / Math.max(sum, 1e-6)))
    return [hue, sat]
  }
  const [hue, sat] = strong(peak)
  const apart = (b: number) => {
    const distance = (b + hues - peak) % hues
    return Math.min(distance, hues - distance) >= 4
  }
  const next = heaviest(all.filter(apart))
  const second: Rgb =
    next !== undefined && run(next) >= run(peak) * 0.12
      ? hsvToRgb(...strong(next), 1)
      : hsvToRgb((hue + 40 / 360) % 1, 0.75, 1)
  return withSecond(hsvToRgb(hue, sat, 1), second)
}

// GL --------------------------------------------------------------------

interface Target {
  readonly texture: WebGLTexture
  readonly framebuffer: WebGLFramebuffer
  readonly width: number
  readonly height: number
}

const makeTarget = (
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
): Target => {
  const texture = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA8,
    width,
    height,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    null,
  )
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  const framebuffer = gl.createFramebuffer()
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
  gl.framebufferTexture2D(
    gl.FRAMEBUFFER,
    gl.COLOR_ATTACHMENT0,
    gl.TEXTURE_2D,
    texture,
    0,
  )
  gl.clearColor(0, 0, 0, 0)
  gl.clear(gl.COLOR_BUFFER_BIT)
  return { texture, framebuffer, width, height }
}

const errors: Array<string> = []

const compile = (
  gl: WebGL2RenderingContext,
  label: string,
  vertex: string,
  fragment: string,
): WebGLProgram | null => {
  const shader = (type: number, source: string): WebGLShader | null => {
    const s = gl.createShader(type)
    if (s === null) return null
    gl.shaderSource(s, source)
    gl.compileShader(s)
    if (gl.getShaderParameter(s, gl.COMPILE_STATUS) !== true) {
      const message = `${label}: ${gl.getShaderInfoLog(s) ?? 'compile failed'}`
      errors.push(message)
      console.error(message)
      return null
    }
    return s
  }
  const v = shader(gl.VERTEX_SHADER, vertex)
  const f = shader(gl.FRAGMENT_SHADER, fragment)
  if (v === null || f === null) return null
  const program = gl.createProgram()
  gl.attachShader(program, v)
  gl.attachShader(program, f)
  gl.linkProgram(program)
  if (gl.getProgramParameter(program, gl.LINK_STATUS) !== true) {
    const message = `${label}: ${gl.getProgramInfoLog(program) ?? 'link failed'}`
    errors.push(message)
    console.error(message)
    return null
  }
  return program
}

const shaderText = (name: string): string => SHADERS[name] ?? ''
const VERSION = '#version 300 es\n'
const fragmentSource = (name: string, defines = ''): string =>
  VERSION +
  defines +
  shaderText('common.glsl') +
  shaderText('fragment.glsl') +
  shaderText('helpers.glsl') +
  shaderText(name)
const VERTEX = VERSION + shaderText('fullscreen.vert')
const LAND_VERTEX =
  VERSION +
  '#define TERRAIN_LAND\n' +
  shaderText('common.glsl') +
  shaderText('helpers.glsl') +
  shaderText('terrain.glsl') +
  shaderText('terrain.vert')
const LAND_FRAGMENT =
  VERSION + shaderText('common.glsl') + shaderText('terrain.frag')

interface Program {
  readonly program: WebGLProgram
  readonly uniforms: Map<string, WebGLUniformLocation>
}

const program = (
  gl: WebGL2RenderingContext,
  label: string,
  vertex: string,
  fragment: string,
): Program | null => {
  const compiled = compile(gl, label, vertex, fragment)
  if (compiled === null) return null
  const uniforms = new Map<string, WebGLUniformLocation>()
  const count = Number(gl.getProgramParameter(compiled, gl.ACTIVE_UNIFORMS))
  for (let i = 0; i < count; i++) {
    const info = gl.getActiveUniform(compiled, i)
    if (info === null) continue
    const name = info.name.replace(/\[0\]$/, '')
    const location = gl.getUniformLocation(compiled, info.name)
    if (location !== null) uniforms.set(name, location)
  }
  return { program: compiled, uniforms }
}

interface Scene {
  readonly def: SceneDef
  readonly main: Program | null
  readonly land: Program | null
  targets: [Target, Target]
  seed: number
  started: number
}

const dataTexture = (
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
  format: 'r' | 'rgba',
  repeat: boolean,
): WebGLTexture => {
  const texture = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, texture)
  const internal = format === 'r' ? gl.R8 : gl.RGBA8
  const pixel = format === 'r' ? gl.RED : gl.RGBA
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    internal,
    width,
    height,
    0,
    pixel,
    gl.UNSIGNED_BYTE,
    null,
  )
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  const wrap = repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap)
  return texture
}

/** The same random texture the TV makes: xorshift from one seed. */
const noisePixels = (): Uint8Array => {
  const side = 256
  const red = new Uint8Array(side * side)
  let state = 0x2545f491
  for (let i = 0; i < red.length; i++) {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    red[i] = (state >>> 24) & 0xff
  }
  const pixels = new Uint8Array(side * side * 4)
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const i = (y * side + x) * 4
      pixels[i] = red[y * side + x] ?? 0
      pixels[i + 1] = red[((y + 17) % side) * side + ((x + 37) % side)] ?? 0
      pixels[i + 2] = 0
      pixels[i + 3] = 255
    }
  }
  return pixels
}

/**
 * Fractal noise worked out ahead, the same numbers as the TV's
 * `fbm_pixels`: red is the value, green and blue its slope across and up,
 * alpha the same noise turned a quarter and moved.
 */
const FBM_SIDE = 256
const FBM_UNITS = 8
const fbmPixels = (): Uint8Array => {
  // Each octave's turn from the first, as rows: (2 -1; 1 2), then
  // (0 -2; 2 0) times the one before, twice.
  const turns: Array<[number, number, number, number]> = [
    [1, 0, 0, 1],
    [2, -1, 1, 2],
    [-2, -4, 4, -2],
    [-8, 4, -4, -8],
  ]
  const total = 0.5 + 0.25 + 0.125 + 0.0625
  const perUnit = FBM_SIDE / FBM_UNITS
  const byte = (value: number) => Math.round(clamp01(value) * 255)
  const wrap = (cell: number) =>
    (((Math.trunc(cell) % FBM_UNITS) + FBM_UNITS) % FBM_UNITS) >>> 0
  const smooth = (octave: number, x: number, y: number) => {
    const lattice = (cx: number, cy: number) =>
      unit((hash((hash(octave) + wrap(cy)) >>> 0) + wrap(cx)) >>> 0)
    const ix = Math.floor(x)
    const iy = Math.floor(y)
    const fx = x - ix
    const fy = y - iy
    const ux = fx * fx * (3 - 2 * fx)
    const uy = fy * fy * (3 - 2 * fy)
    const dx = 6 * fx * (1 - fx)
    const dy = 6 * fy * (1 - fy)
    const a = lattice(ix, iy)
    const b = lattice(ix + 1, iy)
    const c = lattice(ix, iy + 1)
    const d = lattice(ix + 1, iy + 1)
    const twist = a - b - c + d
    return [
      a + (b - a) * ux + (c - a) * uy + twist * ux * uy,
      dx * (b - a + twist * uy),
      dy * (c - a + twist * ux),
    ] as const
  }
  const fbmAt = (x: number, y: number) => {
    let value = 0
    let across = 0
    let up = 0
    let amplitude = 0.5
    turns.forEach(([a, b, c, d], octave) => {
      const shift = octave * 0.37
      const [n, nx, ny] = smooth(
        octave,
        a * x + b * y + shift,
        c * x + d * y + shift * 1.7,
      )
      value += amplitude * n
      across += amplitude * (a * nx + c * ny)
      up += amplitude * (b * nx + d * ny)
      amplitude *= 0.5
    })
    return [value / total, across / total, up / total] as const
  }
  const pixels = new Uint8Array(FBM_SIDE * FBM_SIDE * 4)
  for (let row = 0; row < FBM_SIDE; row++) {
    for (let column = 0; column < FBM_SIDE; column++) {
      const x = (column + 0.5) / perUnit
      const y = (row + 0.5) / perUnit
      const [value, across, up] = fbmAt(x, y)
      const [turned] = fbmAt(8 - y + 3.3, x + 1.9)
      const at = (row * FBM_SIDE + column) * 4
      pixels[at] = byte(value)
      pixels[at + 1] = byte(0.5 + across / 8)
      pixels[at + 2] = byte(0.5 + up / 8)
      pixels[at + 3] = byte(turned)
    }
  }
  return pixels
}

const toBytes = (
  values: Float32Array,
  map: (v: number) => number,
): Uint8Array => {
  const out = new Uint8Array(values.length)
  values.forEach((v, i) => {
    out[i] = Math.round(clamp01(map(v)) * 255)
  })
  return out
}

/** Everything that draws: the scenes, bloom, and the screen. */
const makeEngine = (
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
) => {
  const vao = gl.createVertexArray()
  const scenes: Array<Scene> = SCENES.map((def, index) => ({
    def,
    main: program(gl, def.file, VERTEX, fragmentSource(def.file)),
    land: def.land
      ? program(gl, 'terrain.vert', LAND_VERTEX, LAND_FRAGMENT)
      : null,
    targets: [makeTarget(gl, width, height), makeTarget(gl, width, height)],
    seed: (index * 0.137) % 1,
    started: 0,
  }))
  const bright = program(
    gl,
    'bright.glsl',
    VERTEX,
    fragmentSource('bright.glsl'),
  )
  const blur = program(gl, 'blur.glsl', VERTEX, fragmentSource('blur.glsl'))
  const final = program(gl, 'final.glsl', VERTEX, fragmentSource('final.glsl'))
  // Each change of scene is `final.glsl` built with its own code (gpu.rs).
  const changes = TRANSITIONS.map((name, code) =>
    code === 0
      ? null
      : program(
          gl,
          `final.glsl (${name})`,
          VERTEX,
          fragmentSource('final.glsl', `#define TRANSITION ${code}\n`),
        ),
  )
  const present = program(
    gl,
    'present.glsl',
    VERTEX,
    fragmentSource('present.glsl'),
  )
  const picture = makeTarget(gl, width, height)
  // The glow, which `final` reads, and the bright parts it is blurred
  // from, an eighth of the scenes' size each way (`BLOOM_DIVISOR`).
  const bloomWidth = Math.max(1, Math.floor(width / BLOOM_DIVISOR))
  const bloomHeight = Math.max(1, Math.floor(height / BLOOM_DIVISOR))
  const glow = makeTarget(gl, bloomWidth, bloomHeight)
  const brightParts = makeTarget(gl, bloomWidth, bloomHeight)

  const spectrumTexture = dataTexture(gl, BANDS, 1, 'r', false)
  const historyTexture = dataTexture(gl, BANDS, HISTORY_ROWS, 'r', false)
  const waveTexture = dataTexture(gl, WAVE, 1, 'r', false)
  const noiseTexture = dataTexture(gl, 256, 256, 'rgba', true)
  gl.bindTexture(gl.TEXTURE_2D, noiseTexture)
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA8,
    256,
    256,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    noisePixels(),
  )
  const fbmTexture = dataTexture(gl, FBM_SIDE, FBM_SIDE, 'rgba', true)
  gl.bindTexture(gl.TEXTURE_2D, fbmTexture)
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA8,
    FBM_SIDE,
    FBM_SIDE,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    fbmPixels(),
  )
  const coverTexture = dataTexture(gl, COVER, COVER, 'rgba', false)
  const scoreTexture = dataTexture(gl, SCORE_COLUMNS, AHEAD_ROWS, 'r', false)
  let scoreRate = 0
  let scoreShift = 0
  const history = new Uint8Array(BANDS * HISTORY_ROWS)
  let historyAge = 0
  // Joshify green in its three shades and teal, until a cover loads.
  let colors: Array<Rgb> = [
    [0.13, 0.83, 0.44],
    [0.0975, 0.6225, 0.33],
    [0.065, 0.415, 0.22],
    [0.15, 0.85, 0.95],
  ]
  let hasCover = 0

  const setCover = (source: HTMLCanvasElement | HTMLImageElement) => {
    const canvas = document.createElement('canvas')
    canvas.width = COVER
    canvas.height = COVER
    const context = canvas.getContext('2d')
    if (context === null) return
    context.drawImage(source, 0, 0, COVER, COVER)
    const data = context.getImageData(0, 0, COVER, COVER)
    gl.bindTexture(gl.TEXTURE_2D, coverTexture)
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA8,
      COVER,
      COVER,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      new Uint8Array(data.data.buffer),
    )
    colors = strongColors(data.data)
    hasCover = 1
  }

  const bindTextures = (p: Program, prev: Target | null) => {
    const units: Array<[string, WebGLTexture | null]> = [
      ['uCover', coverTexture],
      ['uSpectrum', spectrumTexture],
      ['uHistory', historyTexture],
      ['uWave', waveTexture],
      ['uPrev', prev?.texture ?? null],
      ['uNoise', noiseTexture],
      ['uFbm', fbmTexture],
      ['uScore', scoreTexture],
    ]
    units.forEach(([name, texture], unit) => {
      const at = p.uniforms.get(name)
      if (at === undefined) return
      gl.activeTexture(gl.TEXTURE0 + unit)
      gl.bindTexture(gl.TEXTURE_2D, texture)
      gl.uniform1i(at, unit)
    })
  }

  const setMusic = (
    p: Program,
    music: Music,
    res: [number, number],
    scene: Scene | null,
  ) => {
    const f = (name: string, value: number) => {
      const at = p.uniforms.get(name)
      if (at !== undefined) gl.uniform1f(at, value)
    }
    const at = (name: string) => p.uniforms.get(name)
    const resAt = at('uRes')
    if (resAt !== undefined) gl.uniform2f(resAt, res[0], res[1])
    f('uTime', music.time)
    f('uSceneTime', scene === null ? 0 : music.time - scene.started)
    f('uDrive', music.drive)
    f('uBeats', music.beats)
    f('uBar', music.bar)
    f('uBeatPulse', music.beatPulse)
    f('uBarPulse', music.barPulse)
    f('uKick', music.kick)
    f('uHit', hit(music))
    f('uAccent', music.accent)
    f('uEnergy', music.energy)
    f('uTension', music.tension)
    f('uDrop', music.drop)
    f('uIntensity', music.intensity)
    f('uSeed', scene?.seed ?? 0)
    f('uHasCover', hasCover)
    f('uHistoryAge', historyAge)
    f('uBeatSeconds', music.beatSeconds)
    const parts = music.parts
    f('uSnare', parts.snare)
    f('uHat', parts.hat)
    f('uDrums', parts.drums)
    f('uLead', parts.lead)
    f('uMelody', parts.melody)
    f('uBass', parts.bass)
    f('uBright', parts.brightness)
    f('uChordChange', parts.chordChange)
    f('uStop', parts.stop)
    f('uRiser', parts.riser)
    f('uFill', parts.fill)
    f('uRepeat', parts.repeat)
    f('uCueIn', music.cue?.until ?? 99)
    f('uCueBuild', music.cue?.build ?? 0)
    f('uCueClimax', music.cue?.climax ?? 0)
    f('uScoreRate', scoreRate)
    f('uScoreShift', scoreShift)
    f('uScoreBehind', AHEAD_BEHIND)
    const bandsAt = at('uBands')
    if (bandsAt !== undefined) gl.uniform4f(bandsAt, ...music.bands)
    const levelsAt = at('uLevels')
    if (levelsAt !== undefined) gl.uniform1fv(levelsAt, music.levels)
    const names = ['uColorA', 'uColorB', 'uColorC', 'uColorD']
    names.forEach((name, i) => {
      const c = at(name)
      const color = colors[i]
      if (c !== undefined && color !== undefined)
        gl.uniform3f(c, ...turned(color, parts.turn, 0.12 * parts.minor))
    })
    const moved = motion(music, scene?.seed ?? 0)
    const pourAt = at('uPour')
    if (pourAt !== undefined) gl.uniform4fv(pourAt, moved.pour)
    const turnAt = at('uTurn')
    if (turnAt !== undefined) gl.uniform4f(turnAt, ...moved.turn)
    const flightAt = at('uFlight')
    if (flightAt !== undefined) gl.uniform4f(flightAt, ...moved.flight)
    const shakeAt = at('uShake')
    if (shakeAt !== undefined) gl.uniform2f(shakeAt, ...moved.shake)
  }

  const fullscreen = () => gl.drawArrays(gl.TRIANGLES, 0, 3)

  /** Draw into `target`, all of it, as the TV's `begin_pass`. */
  const beginPass = (target: Target) => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer)
    gl.viewport(0, 0, target.width, target.height)
    gl.invalidateFramebuffer(gl.FRAMEBUFFER, [gl.COLOR_ATTACHMENT0])
  }

  const drawScene = (scene: Scene, music: Music) => {
    const [read, write] = scene.targets
    beginPass(write)
    if (scene.main !== null) {
      gl.useProgram(scene.main.program)
      setMusic(scene.main, music, [write.width, write.height], scene)
      bindTextures(scene.main, read)
      fullscreen()
    }
    if (scene.land !== null) {
      gl.useProgram(scene.land.program)
      setMusic(scene.land, music, [write.width, write.height], scene)
      bindTextures(scene.land, null)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, LAND_VERTICES)
    }
    scene.targets = [write, read]
  }

  /** Start the spectrum's history from `rows`, as a song's window opens. */
  const setHistory = (rows: Uint8Array, age: number) => {
    history.set(rows.subarray(0, history.length))
    historyAge = age
    gl.bindTexture(gl.TEXTURE_2D, historyTexture)
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.R8,
      BANDS,
      HISTORY_ROWS,
      0,
      gl.RED,
      gl.UNSIGNED_BYTE,
      history,
    )
  }

  /** The app's shade: lyrics on the right (`side`) or the song alone. */
  let side = 0
  const setSide = (on: boolean) => {
    side = on ? 1 : 0
  }

  const update = (music: Music, dt: number) => {
    scoreRate = music.ahead?.rate ?? 0
    scoreShift = music.ahead?.shift ?? 0
    if (music.ahead !== undefined) {
      gl.bindTexture(gl.TEXTURE_2D, scoreTexture)
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.R8,
        SCORE_COLUMNS,
        AHEAD_ROWS,
        0,
        gl.RED,
        gl.UNSIGNED_BYTE,
        music.ahead.rows,
      )
    }
    gl.bindTexture(gl.TEXTURE_2D, spectrumTexture)
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.R8,
      BANDS,
      1,
      0,
      gl.RED,
      gl.UNSIGNED_BYTE,
      toBytes(music.spectrum, v => v),
    )
    gl.bindTexture(gl.TEXTURE_2D, waveTexture)
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.R8,
      WAVE,
      1,
      0,
      gl.RED,
      gl.UNSIGNED_BYTE,
      toBytes(music.wave, v => v * 0.5 + 0.5),
    )
    let rows = 0
    if (music.rows !== undefined && music.historyAge !== undefined) {
      rows = music.rows
      historyAge = music.historyAge
    } else {
      historyAge += dt * HISTORY_RATE
      if (historyAge >= 1) {
        historyAge = Math.min(historyAge - 1, 1)
        rows = 1
      }
    }
    for (let row = 0; row < rows; row++) {
      history.copyWithin(BANDS, 0, BANDS * (HISTORY_ROWS - 1))
      history.set(
        toBytes(music.spectrum, v => v),
        0,
      )
    }
    if (rows > 0) {
      gl.bindTexture(gl.TEXTURE_2D, historyTexture)
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.R8,
        BANDS,
        HISTORY_ROWS,
        0,
        gl.RED,
        gl.UNSIGNED_BYTE,
        history,
      )
    }
  }

  /**
   * One frame: scene `a`, or, while `b` takes over by `mix`, `b` drawing
   * and `a`'s last frame frozen, destroyed the way `change` says (a wipe
   * when it doesn't), as on the TV. A held frame (a stutter, a stop)
   * draws no scene. `only` draws one pass and skips the rest, for the
   * bench: `scene` draws the scene of this frame, the others what the
   * frames before left.
   */
  const frame = (
    music: Music,
    dt: number,
    a: number,
    b: number,
    mix: number,
    screen: [number, number],
    only?: Pass,
    change?: SceneChange,
  ) => {
    gl.bindVertexArray(vao)
    const runs = (pass: Pass) => only === undefined || only === pass
    if (runs('scene')) update(music, dt)
    const sceneA = scenes[a]
    const sceneB = mix > 0 && b !== a ? scenes[b] : undefined
    if (sceneA === undefined) return
    const look = screenLook(music, colors[0] ?? [1, 1, 1])
    const moving = sceneB ?? sceneA
    if (runs('scene') && !look.hold) drawScene(moving, music)
    const kind =
      sceneB === undefined ? 0 : (change?.kind ?? transitionCode('Wipe'))
    const outA = sceneA.targets[0]
    const outB = (sceneB ?? sceneA).targets[0]
    if (runs('bloom') && bright !== null && blur !== null) {
      beginPass(brightParts)
      gl.useProgram(bright.program)
      setMusic(bright, music, [brightParts.width, brightParts.height], null)
      const passes: Array<[string, Target]> = [
        ['uSceneA', outA],
        ['uSceneB', outB],
      ]
      passes.forEach(([name, target], unit) => {
        gl.activeTexture(gl.TEXTURE0 + unit)
        gl.bindTexture(gl.TEXTURE_2D, target.texture)
        const loc = bright.uniforms.get(name)
        if (loc !== undefined) gl.uniform1i(loc, unit)
      })
      const mixAt = bright.uniforms.get('uMix')
      if (mixAt !== undefined) gl.uniform1f(mixAt, mix)
      const texelAt = bright.uniforms.get('uTexel')
      if (texelAt !== undefined)
        gl.uniform2f(texelAt, 1 / outA.width, 1 / outA.height)
      fullscreen()

      beginPass(glow)
      gl.useProgram(blur.program)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, brightParts.texture)
      const sourceAt = blur.uniforms.get('uSource')
      if (sourceAt !== undefined) gl.uniform1i(sourceAt, 0)
      const blurTexelAt = blur.uniforms.get('uTexel')
      if (blurTexelAt !== undefined)
        gl.uniform2f(blurTexelAt, 1 / brightParts.width, 1 / brightParts.height)
      fullscreen()
    }
    const finalPass = (kind > 0 ? changes[kind] : null) ?? final
    if (runs('final') && finalPass !== null) {
      beginPass(picture)
      gl.useProgram(finalPass.program)
      setMusic(finalPass, music, [picture.width, picture.height], sceneA)
      // The scene showing first, then the frozen one a change destroys.
      const inputs: Array<[string, WebGLTexture]> = [
        ['uSceneA', outB.texture],
        ['uSceneB', outA.texture],
        ['uBloom', glow.texture],
        ['uNoise', noiseTexture],
        ['uFbm', fbmTexture],
      ]
      inputs.forEach(([name, texture], unit) => {
        gl.activeTexture(gl.TEXTURE0 + unit)
        gl.bindTexture(gl.TEXTURE_2D, texture)
        const loc = finalPass.uniforms.get(name)
        if (loc !== undefined) gl.uniform1i(loc, unit)
      })
      const f = (name: string, value: number) => {
        const at = finalPass.uniforms.get(name)
        if (at !== undefined) gl.uniform1f(at, value)
      }
      const v3 = (name: string, value: Rgb) => {
        const at = finalPass.uniforms.get(name)
        if (at !== undefined) gl.uniform3f(at, ...value)
      }
      f('uMix', mix)
      f('uTransSeed', change?.seed ?? 0.37)
      f('uCueDrain', look.drain)
      f('uCueInhale', look.inhale)
      f('uGlitch', look.glitch)
      f('uGlitchSeed', look.glitchSeed)
      f('uGlitchPosterize', look.posterize)
      f('uPunch', look.punch)
      f('uBulge', look.bulge)
      f('uLift', look.lift)
      f('uSplit', look.split)
      f('uGlow', look.glow)
      v3('uFlash', look.flash)
      v3('uVignette', look.vignette)
      // Fully faded in, under the light shade the app always needs.
      f('uKeep', 1 - 0.227)
      // The lyrics band on the right, or the song alone in the middle.
      f('uSide', side)
      f('uCentre', 1 - side)
      const reach = 0.3 * Math.hypot(picture.width, picture.height)
      const poolAt = finalPass.uniforms.get('uPool')
      if (poolAt !== undefined)
        gl.uniform2f(poolAt, picture.width / reach, picture.height / reach)
      fullscreen()
    }
    if (runs('present') && present !== null) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      gl.viewport(0, 0, screen[0], screen[1])
      gl.clearColor(0, 0, 0, 1)
      gl.clear(gl.COLOR_BUFFER_BIT)
      gl.useProgram(present.program)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, picture.texture)
      const pictureAt = present.uniforms.get('uPicture')
      if (pictureAt !== undefined) gl.uniform1i(pictureAt, 0)
      fullscreen()
    }
  }

  /** Every scene back to black, as a scene the TV brings on starts. */
  const clearScenes = () => {
    for (const scene of scenes) {
      for (const target of scene.targets) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer)
        gl.clearColor(0, 0, 0, 0)
        gl.clear(gl.COLOR_BUFFER_BIT)
      }
    }
  }

  return {
    frame,
    setCover,
    setHistory,
    setSide,
    clearScenes,
    scenes,
  }
}

// PAGE --------------------------------------------------------------------

const element = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Record<string, string> = {},
): HTMLElementTagNameMap[K] => {
  const made = document.createElement(tag)
  for (const [key, value] of Object.entries(attributes))
    made.setAttribute(key, value)
  return made
}

/** Every scene at two moments of the made-up song, still, for a quick look. */
const sheet = () => {
  const root = element('div', { id: 'sheet' })
  document.body.append(root)
  // `?scale=2` draws each still larger, to look closely.
  const scale = Number(new URLSearchParams(location.search).get('scale') ?? 1)
  const width = Math.round(320 * scale)
  const height = Math.round(180 * scale)
  if (scale > 1) root.style.gridTemplateColumns = 'repeat(2, 1fr)'
  const canvas = element('canvas')
  canvas.width = width
  canvas.height = height
  const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true })
  if (gl === null) {
    root.textContent = 'No WebGL 2 here.'
    return
  }
  const engine = makeEngine(gl, width, height)
  engine.setCover(madeUpCover())
  const moments: Array<[string, number]> = [
    ['verse', (60 / 124) * 4 * 12],
    ['build', (60 / 124) * 4 * 19.6],
    ['drop', (60 / 124) * 4 * 20.25],
  ]
  SCENES.forEach((def, index) => {
    const only = MODE.split(':')[1]
    for (const [label, at] of moments) {
      if (only !== undefined && label !== only) continue
      const song = madeUpSong(124)
      let music = song(at - 1)
      for (let step = 0; step < 24; step++) {
        music = song(at - 1 + step / 24)
        engine.frame(music, 1 / 24, index, index, 0, [width, height])
      }
      const tile = element('canvas')
      tile.width = width
      tile.height = height
      tile.getContext('2d')?.drawImage(canvas, 0, 0)
      const figure = element('figure')
      const caption = element('figcaption')
      caption.textContent = `${def.name} · ${label}`
      figure.append(tile, caption)
      root.append(figure)
    }
  })
  if (errors.length > 0) {
    const pre = element('pre')
    pre.textContent = errors.join('\n\n')
    document.body.prepend(pre)
  }
  console.log(`sheet done, ${errors.length} shader errors`)
}

/**
 * Times every scene at the size the TV starts each scene at (1088 × 612)
 * on a 1280 × 720 screen, or at the sizes the URL names:
 * `?screen=1920x1080&scene=896x504` is a 1080p TV holding a scene at 70%.
 * In a software renderer the numbers only rank the scenes against each
 * other (and a change against the code before it): a TV's GPU is far
 * slower, and runs mediump at twice the rate, which this can't show.
 *
 * For each scene: the whole frame, every pass, then each pass alone (the
 * scene's own, the glow, the picture, the screen), each drawn `FRAMES`
 * times between two reads of a pixel, which wait for the GPU. The bench
 * runs `?runs=` times (5) and shows each number's median.
 */
const bench = () => {
  const out = element('pre')
  document.body.append(out)
  const params = new URLSearchParams(location.search)
  const size = (name: string, fallback: [number, number]): [number, number] => {
    const [w, h] = (params.get(name) ?? '').split('x').map(Number)
    return w !== undefined && h !== undefined && w > 0 && h > 0
      ? [w, h]
      : fallback
  }
  const [width, height] = size('screen', [1280, 720])
  const [sceneWidth, sceneHeight] = size('scene', [1088, 612])
  const runs = Math.max(1, Number(params.get('runs') ?? 5))
  const canvas = element('canvas')
  canvas.width = width
  canvas.height = height
  const gl = canvas.getContext('webgl2')
  if (gl === null) {
    out.textContent = 'No WebGL 2 here.'
    return
  }
  const engine = makeEngine(gl, sceneWidth, sceneHeight)
  engine.setCover(madeUpCover())
  const pixel = new Uint8Array(4)
  const finish = () =>
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)
  const FRAMES = 10
  // `?bar=` times another moment of the made-up song (the drop's first
  // bar by default).
  const at = (60 / 124) * 4 * Number(params.get('bar') ?? 20.25)
  const columns = ['frame', 'scene', 'glow', 'picture', 'screen'] as const
  const passes: Record<(typeof columns)[number], Pass | undefined> = {
    frame: undefined,
    scene: 'scene',
    glow: 'bloom',
    picture: 'final',
    screen: 'present',
  }
  const times: Array<Record<string, Array<number>>> = SCENES.map(() => ({}))
  // The lab is no Foldkit app: the bench reads the clock around GPU work
  // it waits for, which is the point of it.
  // oxlint-disable-next-line foldkit/no-impure-call-at-decision-time
  const clock = () => performance.now()
  const time = (index: number, only: Pass | undefined): number => {
    const song = madeUpSong(124)
    finish()
    const started = clock()
    for (let step = 0; step < FRAMES; step++)
      engine.frame(
        song(at + step / 60),
        1 / 60,
        index,
        index,
        0,
        [width, height],
        only,
      )
    finish()
    return (clock() - started) / FRAMES
  }
  // One run a frame, so the page stays responsive between them.
  let run = 0
  const tick = () => {
    times.forEach((row, index) => {
      // Warm up: the scene's targets and programs in use.
      const song = madeUpSong(124)
      for (let step = 0; step < 4; step++)
        engine.frame(song(at - step / 60), 1 / 60, index, index, 0, [
          width,
          height,
        ])
      for (const column of columns) {
        const list = (row[column] ??= [])
        list.push(time(index, passes[column]))
      }
    })
    run++
    const median = (values: ReadonlyArray<number> = []) =>
      [...values].sort((x, y) => x - y)[Math.floor(values.length / 2)] ?? 0
    const lines = SCENES.map((def, index) => {
      const row = times[index] ?? {}
      const cells = columns.map(
        column => `${column} ${median(row[column]).toFixed(2).padStart(6)}`,
      )
      return `${def.name.padEnd(9)} ${cells.join('  ')}`
    })
    out.textContent = [`run ${run} of ${runs} (ms)`, ...lines].join('\n')
    if (run < runs) requestAnimationFrame(tick)
    else
      console.log(
        `bench ${width}x${height} ${sceneWidth}x${sceneHeight}\n${lines.join('\n')}`,
      )
  }
  requestAnimationFrame(tick)
}

const live = () => {
  const controls = element('div', { id: 'controls' })
  const stage = element('div', { id: 'stage' })
  const canvas = element('canvas')
  const hud = element('div', { id: 'hud' })
  stage.append(canvas, hud)
  document.body.append(controls, stage)
  const gl = canvas.getContext('webgl2', { antialias: false })
  if (gl === null) {
    hud.textContent = 'No WebGL 2 here.'
    return
  }
  let scale = 0.66
  let engine = makeEngine(
    gl,
    Math.round(1920 * scale),
    Math.round(1080 * scale),
  )
  let cover: HTMLCanvasElement | HTMLImageElement = madeUpCover()
  engine.setCover(cover)
  let bpm = 124
  let song = madeUpSong(bpm)
  let current = 0
  let next = 0
  let mix = 0
  let auto = true
  let lastSection = ''
  let change: SceneChange = { kind: transitionCode('Wipe'), seed: 0.37 }
  let changeBeats = 2
  const buttons = SCENES.map((def, index) => {
    const button = element('button')
    button.textContent = def.name
    button.addEventListener('click', () => {
      auto = false
      next = index
      mix = 0.0001
    })
    controls.append(button)
    return button
  })
  const autoButton = element('button')
  autoButton.textContent = 'Auto'
  autoButton.addEventListener('click', () => {
    auto = !auto
  })
  controls.append(autoButton)
  const tempo = element('input', {
    type: 'range',
    min: '70',
    max: '175',
    value: String(bpm),
  })
  const tempoLabel = element('label')
  tempoLabel.append('BPM', tempo)
  tempo.addEventListener('input', () => {
    bpm = Number(tempo.value)
    song = madeUpSong(bpm)
  })
  const scaleInput = element('input', {
    type: 'range',
    min: '0.3',
    max: '1',
    step: '0.05',
    value: String(scale),
  })
  const scaleLabel = element('label')
  scaleLabel.append('Resolution', scaleInput)
  scaleInput.addEventListener('change', () => {
    scale = Number(scaleInput.value)
    engine = makeEngine(gl, Math.round(1920 * scale), Math.round(1080 * scale))
    engine.setCover(cover)
  })
  const file = element('input', { type: 'file', accept: 'image/*' })
  const fileLabel = element('label')
  fileLabel.append('Cover', file)
  file.addEventListener('change', () => {
    const chosen = file.files?.[0]
    if (chosen === undefined) return
    const image = new Image()
    image.onload = () => {
      cover = image
      engine.setCover(image)
    }
    image.src = URL.createObjectURL(chosen)
  })
  controls.append(tempoLabel, scaleLabel, fileLabel)

  // Times come from requestAnimationFrame; the first frame starts the clock.
  let started = -1
  let last = 0
  let frames = 0
  let fps = 0
  let fpsAt = 0
  const tick = (now: number) => {
    if (started < 0) {
      started = now
      last = now
      fpsAt = now
    }
    const dt = Math.min(0.1, (now - last) / 1000)
    last = now
    const music = song((now - started) / 1000)
    if (auto && music.section !== lastSection) {
      lastSection = music.section
      const pool: Record<string, ReadonlyArray<number>> = {
        Intro: [0, 5, 1],
        Verse: [1, 2],
        Build: [2, 3],
        Drop: [4, 6, 3],
        Breakdown: [5, 0, 1],
      }
      const options = pool[music.section] ?? [0]
      const choice = options[Math.floor(music.beats / 32) % options.length] ?? 0
      // The way the director would change: a drop shatters, the build
      // rushes through, a quieter part melts, the rest wipe.
      const ways: Record<string, [string, number]> = {
        Drop: ['Shatter', 2],
        Build: ['ZoomThrough', 2],
        Breakdown: ['Melt', 4],
        Verse: ['Datamosh', 4],
      }
      const [way, beats] = ways[music.section] ?? ['Wipe', 4]
      if (choice !== current) {
        next = choice
        mix = 0.0001
        change = { kind: transitionCode(way), seed: fract(music.beats * 0.618) }
        changeBeats = beats
      }
    }
    if (mix > 0) {
      mix = Math.min(1, mix + dt / ((60 / bpm) * changeBeats))
      if (mix >= 1) {
        current = next
        mix = 0
      }
    }
    canvas.width = canvas.clientWidth * devicePixelRatio
    canvas.height = canvas.clientHeight * devicePixelRatio
    engine.frame(
      music,
      dt,
      current,
      next,
      mix,
      [canvas.width, canvas.height],
      undefined,
      change,
    )
    buttons.forEach((button, index) =>
      button.setAttribute('aria-pressed', String(index === current)),
    )
    autoButton.setAttribute('aria-pressed', String(auto))
    frames++
    if (now - fpsAt > 500) {
      fps = (frames * 1000) / (now - fpsAt)
      frames = 0
      fpsAt = now
    }
    hud.textContent = `${SCENES[current]?.name ?? ''}  ${music.section}  bar ${Math.floor(music.beats / 4) % 32}  ${fps.toFixed(0)} fps\nenergy ${music.energy.toFixed(2)}  tension ${music.tension.toFixed(2)}  drop ${music.drop.toFixed(2)}`
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

// A REAL SONG ---------------------------------------------------------------

/**
 * One frame of a real song, as the TV's own listener and director saw it:
 * written by `cargo test -p music-tv visuals::lab -- --ignored` (see
 * `apps/tv/src/visuals/lab.rs`).
 */
interface SongFrame {
  readonly t: number
  readonly music: {
    readonly time: number
    readonly dt: number
    readonly drive: number
    readonly beats: number
    readonly bar: number
    readonly beatPulse: number
    readonly barPulse: number
    readonly kick: number
    readonly accent: number
    readonly bands: [number, number, number, number]
    readonly levels: Array<number>
    readonly energy: number
    readonly tension: number
    readonly drop: number
    readonly intensity: number
    readonly section: string | null
    readonly beatSeconds: number
    readonly parts?: Partial<Parts>
    readonly ceiling?: number
    readonly cue?: Cues
  }
  /** The score around now, as hex, when the song has one. */
  readonly ahead?: string
  readonly aheadShift?: number
  readonly aheadRate?: number
  readonly shot: {
    readonly scene: number
    readonly seed: number
    readonly age: number
    readonly next: {
      readonly scene: number
      readonly seed: number
      readonly age: number
      readonly progress: number
    } | null
    /** How the scene taking over destroys the frozen one. */
    readonly kind?: string
  }
  readonly spectrum: string
  readonly wave: string
  readonly rows: number
  readonly historyAge: number
}

interface SongWindow {
  readonly start: number
  readonly end: number
  readonly history?: string
  readonly frames: ReadonlyArray<SongFrame>
}

interface TimelinePoint {
  readonly t: number
  readonly scene: number
  readonly energy: number
  readonly intensity: number
  readonly tension: number
  readonly drop: number
  readonly level: number
}

interface SongData {
  readonly videoId: string
  readonly title?: string
  readonly tempo: number
  readonly duration: number
  readonly sections: ReadonlyArray<{
    readonly start: number
    readonly end: number
    readonly kind: string
    readonly energy: number
  }>
  readonly drops: ReadonlyArray<number>
  readonly timeline: ReadonlyArray<TimelinePoint>
  readonly windows: ReadonlyArray<SongWindow>
}

const fromHex = (hex: string): Uint8Array => {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++)
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

const songMusic = (frame: SongFrame): Music => {
  const m = frame.music
  return {
    time: m.time,
    beatSeconds: m.beatSeconds,
    parts: { ...NO_PARTS, ...m.parts },
    ...(frame.ahead === undefined
      ? {}
      : {
          ahead: {
            rows: fromHex(frame.ahead),
            shift: frame.aheadShift ?? 0,
            rate: frame.aheadRate ?? 0,
          },
        }),
    drive: m.drive,
    beats: m.beats,
    bar: m.bar,
    beatPulse: m.beatPulse,
    barPulse: m.barPulse,
    kick: m.kick,
    accent: m.accent,
    bands: m.bands,
    levels: m.levels,
    energy: m.energy,
    tension: m.tension,
    drop: m.drop,
    intensity: m.intensity,
    spectrum: Float32Array.from(fromHex(frame.spectrum), b => b / 255),
    wave: Float32Array.from(fromHex(frame.wave), b => (b / 255) * 2 - 1),
    section: m.section ?? '',
    rows: frame.rows,
    historyAge: frame.historyAge,
    ...(m.ceiling === undefined ? {} : { ceiling: m.ceiling }),
    ...(m.cue === undefined ? {} : { cue: m.cue }),
  }
}

const SCENE_COLORS = [
  '#4f8cff',
  '#a46bff',
  '#38d39f',
  '#ffd23f',
  '#ff8a3d',
  '#5fe0e6',
  '#ff6bd5',
]

/**
 * The TV's words over the visuals, with lyrics, for judging them: where
 * and how large `ui/app.slint` draws them (its unit is a 54th of the
 * height), in its solid greys.
 */
const drawOverlay = (
  context: CanvasRenderingContext2D,
  cover: CanvasImageSource | null,
  width: number,
  height: number,
  title: string,
) => {
  const u = height / 54
  const art = u * 24
  const left = u * 5.2
  const top = u * 8.2
  if (cover !== null) context.drawImage(cover, left, top, art, art)
  context.fillStyle = '#ffffff'
  context.font = `800 ${u * 2.3}px system-ui, sans-serif`
  context.fillText(title.slice(0, 22).toUpperCase(), left, top + art + u * 4.4)
  context.fillStyle = '#dfe0e3'
  context.font = `${u * 1.3}px system-ui, sans-serif`
  context.fillText('Artist', left, top + art + u * 6.6)
  const lines = [
    'Hot, hot, hot, the line before',
    'What now, every line runs down',
    'Fresh, watch the line being sung',
    'Pupils dilated, the next line',
    "I'm surfin' on another after",
    'Walk on my path, and the last',
  ]
  lines.forEach((line, index) => {
    const now = index === 2
    context.fillStyle = now ? '#ffffff' : index < 2 ? '#6e7178' : '#b4b7bd'
    context.font = `${now ? 800 : 700} ${u * (now ? 2.5 : 2.1)}px system-ui, sans-serif`
    context.fillText(line, u * 37, u * (10 + index * 4.6))
  })
}

interface SheetOptions {
  /** Which window of the song to play. */
  readonly window: number
  /** Song times to show, in seconds. */
  readonly picks: ReadonlyArray<number>
  /** A scene to show throughout; the director's choice when left out. */
  readonly scene?: number
  /** Several scenes, each through the whole window, one after another. */
  readonly scenes?: ReadonlyArray<number>
  readonly width?: number
  readonly height?: number
  readonly columns?: number
  /** Draw the app's words on top, under the lyrics' shade. */
  readonly overlay?: boolean
  readonly title?: string
}

/**
 * A real song: the frames the TV's own listener and director made from it
 * (`apps/tv/src/visuals/lab.rs`), drawn here. A page script (Playwright)
 * calls `labSong.load`, then `labSong.sheet` for contact sheets of chosen
 * moments and `labSong.timeline` for the whole song.
 */
const song = () => {
  const status = element('pre')
  document.body.append(status)
  const canvas = element('canvas')
  const gl = canvas.getContext('webgl2', {
    preserveDrawingBuffer: true,
    antialias: false,
  })
  if (gl === null) {
    status.textContent = 'No WebGL 2 here.'
    return
  }
  let data: SongData | null = null
  let cover: HTMLImageElement | null = null

  const load = async (loaded: SongData, coverUrl?: string) => {
    data = loaded
    cover = null
    if (coverUrl !== undefined) {
      const image = new Image()
      image.src = coverUrl
      await image.decode()
      cover = image
    }
    status.textContent = `${loaded.videoId}: ${loaded.windows.length} windows`
  }

  /** Play a window and return a contact sheet of the picked frames. */
  const sheet = (options: SheetOptions): string => {
    if (data === null) throw new Error('load a song first')
    const played = data.windows[options.window]
    if (played === undefined) throw new Error('no such window')
    const song = data.title ?? data.videoId
    const title = options.title ?? song
    const width = options.width ?? 480
    const height = options.height ?? 270
    const overlay = options.overlay ?? true
    canvas.width = width
    canvas.height = height
    // The scenes at the size the TV starts them at, against its screen.
    const engine = makeEngine(
      gl,
      Math.round(width * 0.85),
      Math.round(height * 0.85),
    )
    engine.setCover(cover ?? madeUpCover())
    engine.setSide(overlay)
    const tiles: Array<{
      image: HTMLCanvasElement
      frame: SongFrame
      scene: string
    }> = []
    // Each scene asked for plays the whole window from black; without any,
    // the director's choice does.
    const runs: ReadonlyArray<number | undefined> = options.scenes ?? [
      options.scene,
    ]
    for (const forced of runs) {
      engine.clearScenes()
      if (played.history !== undefined)
        engine.setHistory(
          fromHex(played.history),
          played.frames[0]?.historyAge ?? 0,
        )
      played.frames.forEach((frame, index) => {
        const music = songMusic(frame)
        const shot = frame.shot
        const a = forced ?? shot.scene
        const next = forced === undefined ? shot.next : null
        const b = next?.scene ?? a
        const mix = next?.progress ?? 0
        const sceneA = engine.scenes[a]
        if (sceneA !== undefined) {
          sceneA.seed = forced === undefined ? shot.seed : 0.37
          sceneA.started =
            music.time - (forced === undefined ? shot.age : frame.t)
        }
        const sceneB = engine.scenes[b]
        if (next !== null && sceneB !== undefined) {
          sceneB.seed = next.seed
          sceneB.started = music.time - next.age
        }
        engine.frame(
          music,
          frame.music.dt,
          a,
          b,
          mix,
          [width, height],
          undefined,
          next === null
            ? undefined
            : { kind: transitionCode(shot.kind ?? 'Wipe'), seed: next.seed },
        )
        const following = played.frames[index + 1]
        const wanted = options.picks.filter(
          pick =>
            pick >= frame.t - 1e-6 &&
            (following === undefined || pick < following.t - 1e-6),
        )
        for (const _ of wanted) {
          const tile = element('canvas')
          tile.width = width
          tile.height = height
          const context = tile.getContext('2d')
          if (context === null) continue
          context.drawImage(canvas, 0, 0)
          if (overlay) drawOverlay(context, cover, width, height, song)
          const into =
            next === null
              ? ''
              : ` ${shot.kind ?? '→'} ${SCENES[b]?.name ?? ''} ${Math.round(mix * 100)}%`
          tiles.push({
            image: tile,
            frame,
            scene: (SCENES[a]?.name ?? '') + into,
          })
        }
      })
    }

    // The sheet: each frame, and under it the music that drove it.
    const columns = options.columns ?? Math.min(tiles.length, 4)
    const rows = Math.ceil(tiles.length / columns)
    const gap = 8
    const caption = 64
    const header = 28
    const out = element('canvas')
    out.width = columns * (width + gap) + gap
    out.height = header + rows * (height + caption + gap) + gap
    const context = out.getContext('2d')
    if (context === null) throw new Error('no 2D canvas')
    context.fillStyle = '#0b0d12'
    context.fillRect(0, 0, out.width, out.height)
    context.fillStyle = '#ece9f5'
    context.font = '600 15px system-ui, sans-serif'
    context.fillText(title, gap, 19)
    tiles.forEach(({ image, frame, scene }, index) => {
      const x = gap + (index % columns) * (width + gap)
      const y = header + Math.floor(index / columns) * (height + caption + gap)
      context.drawImage(image, x, y)
      const m = frame.music
      const phase = m.beats - Math.floor(m.beats)
      context.fillStyle = '#ece9f5'
      context.font = '12px ui-monospace, monospace'
      context.fillText(
        `${frame.t.toFixed(2)}s  beat ${Math.floor(m.beats)}+${phase.toFixed(2)}  ${m.section ?? ''}  ${scene}`,
        x,
        y + height + 14,
      )
      const meters: Array<[string, number, string]> = [
        ['kick', m.kick, '#ff6b6b'],
        ['beat', m.beatPulse, '#ffd23f'],
        ['energy', m.energy, '#38d39f'],
        ['intens', m.intensity, '#4f8cff'],
        ['tension', m.tension, '#ff8a3d'],
        ['drop', m.drop, '#ff6bd5'],
      ]
      meters.forEach(([label, value, color], meter) => {
        const mx = x + (meter % 3) * (width / 3)
        const my = y + height + 22 + Math.floor(meter / 3) * 18
        context.fillStyle = '#8c88a0'
        context.font = '11px ui-monospace, monospace'
        context.fillText(label, mx, my + 10)
        context.fillStyle = '#2a2738'
        const barWidth = width / 3 - 62
        context.fillRect(mx + 54, my + 2, barWidth, 9)
        context.fillStyle = color
        context.fillRect(mx + 54, my + 2, barWidth * clamp01(value), 9)
      })
    })
    return out.toDataURL('image/jpeg', 0.86)
  }

  /**
   * The whole song: the level heard, energy, intensity, tension and drop
   * over time, the sections and drops, and the scene the director chose.
   */
  const timeline = (width = 1600, height = 260): string => {
    if (data === null) throw new Error('load a song first')
    const played = data
    const out = element('canvas')
    out.width = width
    out.height = height
    const context = out.getContext('2d')
    if (context === null) throw new Error('no 2D canvas')
    const x = (t: number) => (t / played.duration) * width
    const plot = height - 70
    context.fillStyle = '#0b0d12'
    context.fillRect(0, 0, width, height)
    played.sections.forEach((section, index) => {
      context.fillStyle = index % 2 === 0 ? '#14131c' : '#1f1d2b'
      context.fillRect(
        x(section.start),
        20,
        x(section.end) - x(section.start),
        plot,
      )
      context.fillStyle = '#8c88a0'
      context.font = '11px system-ui, sans-serif'
      context.fillText(
        `${section.kind} ${section.energy.toFixed(2)}`,
        x(section.start) + 3,
        32,
      )
    })
    const line = (pick: (point: TimelinePoint) => number, color: string) => {
      context.strokeStyle = color
      context.lineWidth = 1.5
      context.beginPath()
      played.timeline.forEach((point, index) => {
        const px = x(point.t)
        const py = 20 + plot - pick(point) * (plot - 20)
        if (index === 0) context.moveTo(px, py)
        else context.lineTo(px, py)
      })
      context.stroke()
    }
    line(point => point.level, '#5a5670')
    line(point => point.energy, '#38d39f')
    line(point => point.intensity, '#4f8cff')
    line(point => point.tension, '#ff8a3d')
    line(point => point.drop, '#ff6bd5')
    for (const drop of played.drops) {
      context.fillStyle = '#ff6bd5'
      context.fillRect(x(drop) - 1, 20, 2, plot)
    }
    let last = -1
    played.timeline.forEach((point, index) => {
      const end = played.timeline[index + 1]?.t ?? played.duration
      context.fillStyle = SCENE_COLORS[point.scene] ?? '#ffffff'
      context.fillRect(x(point.t), height - 44, x(end) - x(point.t) + 1, 14)
      if (point.scene === last) return
      last = point.scene
      context.fillStyle = '#ece9f5'
      context.font = '11px system-ui, sans-serif'
      context.fillText(
        SCENES[point.scene]?.name ?? '',
        x(point.t) + 2,
        height - 16,
      )
    })
    context.fillStyle = '#ece9f5'
    context.font = '600 13px system-ui, sans-serif'
    context.fillText(
      `${played.title ?? played.videoId}  ${played.tempo.toFixed(0)} BPM    grey level · green energy · blue intensity · orange tension · pink drop`,
      6,
      14,
    )
    return out.toDataURL('image/png')
  }

  Object.assign(globalThis, { labSong: { load, sheet, timeline } })
  status.textContent =
    'labSong: load(data, coverUrl), sheet(options), timeline()'
}

if (MODE.startsWith('sheet')) sheet()
else if (MODE === 'moments')
  momentsPage({
    scenes: SCENES.map(scene => scene.name),
    makeEngine,
    song: madeUpSong,
    cover: madeUpCover,
  })
else if (MODE === 'bench') bench()
else if (MODE === 'song') song()
else live()
