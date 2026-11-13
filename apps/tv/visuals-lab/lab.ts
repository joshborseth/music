/*
 * The visuals lab: the TV's shaders and render passes, driven by a made-up
 * song (or a real audio file), so scenes can be tuned in a browser.
 *
 * The passes match `apps/tv/src/visuals/gpu.rs`: each scene draws into its
 * own pair of textures (feedback), Particles adding its grains as points
 * and Terrain its land as a mesh, the bright parts are blurred at a
 * quarter size, `final.glsl` puts it together at the scenes' size, and
 * `present.glsl` stretches that to the screen under the app's shade. While
 * one scene dissolves into the next, the two take turns, one a frame. The
 * per-frame values in `motion` match `motion.rs`.
 */

declare const SHADERS: Readonly<Record<string, string>>
declare const MODE: string

interface SceneDef {
  readonly name: string
  readonly file: string
  /** Grains drawn as points on top (particles.vert). */
  readonly points: boolean
  /** The land drawn as a mesh on top (terrain.vert). */
  readonly land: boolean
}

const SCENES: ReadonlyArray<SceneDef> = [
  { name: 'Liquid', file: 'liquid.glsl', points: false, land: false },
  { name: 'Ink', file: 'ink.glsl', points: false, land: false },
  { name: 'Kaleido', file: 'kaleido.glsl', points: false, land: false },
  { name: 'Terrain', file: 'terrain.glsl', points: false, land: true },
  { name: 'Chrome', file: 'chrome.glsl', points: false, land: false },
  { name: 'Tunnel', file: 'tunnel.glsl', points: false, land: false },
  { name: 'Halo', file: 'halo.glsl', points: false, land: false },
  { name: 'Particles', file: 'particles.glsl', points: true, land: false },
]

const BANDS = 48
const HISTORY_ROWS = 128
const HISTORY_RATE = 32
const WAVE = 512
const COVER = 256
const GRID = 160
/**
 * Terrain's mesh: a column on each band, the road and its edge, and five
 * far columns, each side; a row for each history row and the far edge.
 * Drawn as one triangle strip a pair of rows, joined by empty triangles:
 * the TV's `LAND_VERTICES`, worked out the same way as `terrain.vert`.
 */
const LAND_COLUMNS = 2 * (1 + BANDS + 5) + 1
const LAND_VERTICES = HISTORY_ROWS * (2 * LAND_COLUMNS + 2) - 2

// MUSIC ----------------------------------------------------------------

interface Music {
  time: number
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

type Vec3 = [number, number, number]

const length3 = (v: Vec3): number => Math.hypot(v[0], v[1], v[2])
const normalize3 = (v: Vec3): Vec3 => {
  const l = Math.max(length3(v), 1e-6)
  return [v[0] / l, v[1] / l, v[2] / l]
}
const cross3 = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]
const dot3 = (a: Vec3, b: Vec3): number =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

/** Chrome's lens: the TV's `FOCAL`. */
const FOCAL = 1.6

/**
 * A ball as the camera (where it is, then its right, up, and forward)
 * sees it: its centre on the picture and its radius there. The TV's
 * `project`.
 */
const project = (
  centre: Vec3,
  radius: number,
  [eye, right, up, forward]: [Vec3, Vec3, Vec3, Vec3],
): [number, number, number] => {
  const away: Vec3 = [
    centre[0] - eye[0],
    centre[1] - eye[1],
    centre[2] - eye[2],
  ]
  const ahead = dot3(away, forward)
  const near = clamp01((ahead - 0.2) / 0.4)
  const seen = Math.max(ahead, 0.2)
  return [
    (dot3(away, right) * FOCAL) / seen,
    (dot3(away, up) * FOCAL) / seen,
    ((radius * FOCAL) / seen) * near * near * (3 - 2 * near),
  ]
}

interface Motion {
  readonly blobs: Array<number>
  readonly melt: number
  readonly camera: Array<number>
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
  const punch = 1 + 0.06 * music.kick
  const distance = 2.5 / punch
  const eye: Vec3 = [
    Math.sin(drive * 0.07) * distance,
    0,
    -Math.cos(drive * 0.07) * distance,
  ]
  const forward = normalize3([-eye[0], -eye[1], -eye[2]])
  const right = normalize3([forward[2], 0, -forward[0]])
  const up = cross3(forward, right)

  const gather =
    Math.pow(1 - fract(music.bar), 2) * 0.6 + 0.4 - 0.4 * music.drop
  const spread =
    (0.55 + 0.25 * music.intensity + 1.1 * music.drop) * (1 - 0.35 * gather)
  const blobs: Array<number> = []
  for (let i = 0; i < 5; i++) {
    const centre: Vec3 = [
      Math.sin(drive * (0.31 + i * 0.07) + i * 1.9) * spread,
      Math.cos(drive * (0.27 + i * 0.05) + i * 2.7) * 0.7 * spread,
      Math.sin(drive * (0.19 + i * 0.09) + i * 0.8) * spread,
    ]
    const radius = 0.27 + 0.16 * (music.levels[i] ?? 0) + 0.05 * music.kick
    blobs.push(...project(centre, radius, [eye, right, up, forward]))
  }
  // As far as the old 3D shape melted, seen at the middle's distance.
  const melt = ((0.35 - 0.2 * music.drop) * FOCAL) / distance

  const pour: Array<number> = []
  for (let i = 0; i < 3; i++) {
    const phase = drive * (0.21 + 0.07 * i) + i * 2.1 + seed * 5
    const level = music.bands[i] ?? 0
    const first = i === 0 ? 1 : 0
    pour.push(
      0.55 * Math.sin(phase * 1.3),
      0.32 * Math.cos(phase),
      0.025 + 0.05 * level + 0.06 * music.beatPulse * first,
      0.02 + 0.22 * level + 0.35 * music.kick * first,
    )
  }

  const spin = drive * 0.05 + 0.15 * Math.sin(music.beats * Math.PI * 0.25)
  const bob = 0.04 * music.beatPulse * music.energy - 0.12 * music.drop
  const roll = 0.04 * Math.sin(drive * 0.09)
  const shake = music.tension * music.tension * 0.006
  return {
    blobs,
    melt,
    camera: [...eye, ...right, ...up, ...forward],
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
    return {
      time,
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

/**
 * The cover's one strong color in three shades, like `look.rs`: the hue that
 * covers the most of it, averaged from its own pixels, at full brightness and
 * at least 0.9 saturation; then a little deeper, and deep.
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
  const strong: Rgb =
    total < (pixels.length / 4) * 0.01
      ? [0.13, 0.83, 0.44]
      : (() => {
          const around = (center: number) =>
            [0, 1, 2].map(step => (center + hues - 1 + step) % hues)
          const sumAround = (center: number) =>
            around(center).reduce((sum, b) => sum + (weight[b] ?? 0), 0)
          let peak = 0
          for (let b = 1; b < hues; b++) {
            if (sumAround(b) > sumAround(peak)) peak = b
          }
          const near = around(peak)
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
          return hsvToRgb(hue, sat, 1)
        })()
  const shade = (k: number): Rgb => [
    strong[0] * k,
    strong[1] * k,
    strong[2] * k,
  ]
  return [shade(1), shade(0.75), shade(0.5)]
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
  gl.clearColor(0, 0, 0, 1)
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
const fragmentSource = (name: string): string =>
  VERSION +
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
  readonly points: Program | null
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
    points: def.points
      ? program(
          gl,
          'particles.vert',
          VERSION +
            shaderText('common.glsl') +
            shaderText('helpers.glsl') +
            shaderText('particles.vert'),
          VERSION + shaderText('common.glsl') + shaderText('particles.frag'),
        )
      : null,
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
  const present = program(
    gl,
    'present.glsl',
    VERTEX,
    fragmentSource('present.glsl'),
  )
  const picture = makeTarget(gl, width, height)
  const bloomA = makeTarget(gl, Math.ceil(width / 4), Math.ceil(height / 4))
  const bloomB = makeTarget(gl, Math.ceil(width / 4), Math.ceil(height / 4))

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
  const history = new Uint8Array(BANDS * HISTORY_ROWS)
  let historyAge = 0
  // Joshify green in its three shades, until a cover loads.
  let colors: Array<Rgb> = [
    [0.13, 0.83, 0.44],
    [0.0975, 0.6225, 0.33],
    [0.065, 0.415, 0.22],
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
    f('uAccent', music.accent)
    f('uEnergy', music.energy)
    f('uTension', music.tension)
    f('uDrop', music.drop)
    f('uIntensity', music.intensity)
    f('uSeed', scene?.seed ?? 0)
    f('uHasCover', hasCover)
    f('uHistoryAge', historyAge)
    f('uGrid', GRID)
    const bandsAt = at('uBands')
    if (bandsAt !== undefined) gl.uniform4f(bandsAt, ...music.bands)
    const levelsAt = at('uLevels')
    if (levelsAt !== undefined) gl.uniform1fv(levelsAt, music.levels)
    const names = ['uColorA', 'uColorB', 'uColorC']
    names.forEach((name, i) => {
      const c = at(name)
      const color = colors[i]
      if (c !== undefined && color !== undefined) gl.uniform3f(c, ...color)
    })
    const moved = motion(music, scene?.seed ?? 0)
    f('uMelt', moved.melt)
    const blobsAt = at('uBlobs')
    if (blobsAt !== undefined) gl.uniform3fv(blobsAt, moved.blobs)
    const cameraAt = at('uCamera')
    if (cameraAt !== undefined) gl.uniform3fv(cameraAt, moved.camera)
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
    if (scene.points !== null) {
      gl.enable(gl.BLEND)
      gl.blendFunc(gl.ONE, gl.ONE)
      gl.useProgram(scene.points.program)
      setMusic(scene.points, music, [write.width, write.height], scene)
      bindTextures(scene.points, null)
      gl.drawArrays(gl.POINTS, 0, GRID * GRID)
      gl.disable(gl.BLEND)
    }
    if (scene.land !== null) {
      gl.useProgram(scene.land.program)
      setMusic(scene.land, music, [write.width, write.height], scene)
      bindTextures(scene.land, null)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, LAND_VERTICES)
    }
    scene.targets = [write, read]
  }

  const update = (music: Music, dt: number) => {
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
    historyAge += dt * HISTORY_RATE
    if (historyAge >= 1) {
      historyAge = Math.min(historyAge - 1, 1)
      history.copyWithin(BANDS, 0, BANDS * (HISTORY_ROWS - 1))
      history.set(
        toBytes(music.spectrum, v => v),
        0,
      )
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

  let frames = 0
  /**
   * One frame: scene `a`, dissolving into `b` by `mix`. While both show,
   * they take turns, one a frame, as on the TV.
   */
  const frame = (
    music: Music,
    dt: number,
    a: number,
    b: number,
    mix: number,
    screen: [number, number],
  ) => {
    gl.bindVertexArray(vao)
    update(music, dt)
    frames++
    const sceneA = scenes[a]
    const sceneB = mix > 0 && b !== a ? scenes[b] : undefined
    if (sceneA === undefined) return
    if (sceneB === undefined || frames % 2 === 0) drawScene(sceneA, music)
    if (sceneB !== undefined && frames % 2 === 1) drawScene(sceneB, music)
    const outA = sceneA.targets[0]
    const outB = (sceneB ?? sceneA).targets[0]
    if (bright !== null && blur !== null) {
      beginPass(bloomA)
      gl.useProgram(bright.program)
      setMusic(bright, music, [bloomA.width, bloomA.height], null)
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
      const blurPass = (
        from: Target,
        to: Target,
        direction: [number, number],
      ) => {
        beginPass(to)
        gl.useProgram(blur.program)
        gl.activeTexture(gl.TEXTURE0)
        gl.bindTexture(gl.TEXTURE_2D, from.texture)
        const s = blur.uniforms.get('uSource')
        if (s !== undefined) gl.uniform1i(s, 0)
        const d = blur.uniforms.get('uDirection')
        if (d !== undefined)
          gl.uniform2f(d, direction[0] / from.width, direction[1] / from.height)
        fullscreen()
      }
      blurPass(bloomA, bloomB, [1, 0])
      blurPass(bloomB, bloomA, [0, 1])
    }
    if (final !== null) {
      beginPass(picture)
      gl.useProgram(final.program)
      setMusic(final, music, [picture.width, picture.height], sceneA)
      const inputs: Array<[string, WebGLTexture]> = [
        ['uSceneA', outA.texture],
        ['uSceneB', outB.texture],
        ['uBloom', bloomA.texture],
        ['uNoise', noiseTexture],
      ]
      inputs.forEach(([name, texture], unit) => {
        gl.activeTexture(gl.TEXTURE0 + unit)
        gl.bindTexture(gl.TEXTURE_2D, texture)
        const loc = final.uniforms.get(name)
        if (loc !== undefined) gl.uniform1i(loc, unit)
      })
      const mixAt = final.uniforms.get('uMix')
      if (mixAt !== undefined) gl.uniform1f(mixAt, mix)
      const fadeAt = final.uniforms.get('uFade')
      if (fadeAt !== undefined) gl.uniform1f(fadeAt, 1)
      fullscreen()
    }
    if (present !== null) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      gl.viewport(0, 0, screen[0], screen[1])
      gl.clearColor(0, 0, 0, 1)
      gl.clear(gl.COLOR_BUFFER_BIT)
      gl.useProgram(present.program)
      setMusic(present, music, screen, sceneA)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, picture.texture)
      const pictureAt = present.uniforms.get('uPicture')
      if (pictureAt !== undefined) gl.uniform1i(pictureAt, 0)
      // The song alone in the middle, as the TV shows a song without lyrics.
      const sideAt = present.uniforms.get('uSide')
      if (sideAt !== undefined) gl.uniform1f(sideAt, 0)
      const centreAt = present.uniforms.get('uCentre')
      if (centreAt !== undefined) gl.uniform1f(centreAt, 1)
      fullscreen()
    }
  }

  /** Scene `index` alone, without bloom or the picture: for the bench. */
  const sceneOnly = (music: Music, dt: number, index: number) => {
    const scene = scenes[index]
    if (scene === undefined) return
    gl.bindVertexArray(vao)
    update(music, dt)
    drawScene(scene, music)
  }

  return { frame, sceneOnly, setCover, scenes }
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
 * Times every scene, drawn alone, at the size the TV starts each scene at
 * (1088 × 612) on a 1280 × 720 screen. In a software renderer the numbers
 * only rank the scenes against each other (and a change against the code
 * before it): a TV's GPU is far slower, and runs mediump at twice the
 * rate, which this can't show.
 *
 * Two numbers a scene: the whole frame, every pass, and the scene's own
 * pass alone (what differs between scenes). Each scene warms up in one
 * animation frame and its whole frames are timed over the next: the time
 * between that frame and the one after is the drawing (and at most one
 * display refresh of waiting). Its own pass is timed the same way over
 * the frame after that.
 */
const bench = () => {
  const out = element('pre')
  document.body.append(out)
  const width = 1280
  const height = 720
  const canvas = element('canvas')
  canvas.width = width
  canvas.height = height
  const gl = canvas.getContext('webgl2')
  if (gl === null) {
    out.textContent = 'No WebGL 2 here.'
    return
  }
  const engine = makeEngine(gl, 1088, 612)
  engine.setCover(madeUpCover())
  const pixel = new Uint8Array(4)
  const finish = () =>
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)
  const at = (60 / 124) * 4 * 20.25
  const frames = 8
  const lines: Array<string> = []
  const draw = (index: number, from: number, count: number) => {
    const song = madeUpSong(124)
    for (let step = 0; step < count; step++)
      engine.frame(song(at + (from + step) / 60), 1 / 60, index, index, 0, [
        width,
        height,
      ])
    finish()
  }
  const drawAlone = (index: number) => {
    const song = madeUpSong(124)
    for (let step = 0; step < frames; step++)
      engine.sceneOnly(song(at + step / 60), 1 / 60, index)
    finish()
  }
  // Each scene steps through: warm up, time whole frames, time its pass.
  let index = 0
  let step: 'warm' | 'frames' | 'alone' = 'warm'
  let started = -1
  let frameMs = 0
  const tick = (now: number) => {
    if (step === 'alone') {
      frameMs = (now - started) / frames
      started = now
      drawAlone(index)
      step = 'frames'
      requestAnimationFrame(tick)
      return
    }
    if (step === 'frames' && started >= 0) {
      const alone = (now - started) / frames
      const name = SCENES[index]?.name ?? ''
      lines.push(
        `${name.padEnd(10)} ${frameMs.toFixed(1).padStart(7)} ms a frame ${alone.toFixed(1).padStart(7)} ms its own pass`,
      )
      out.textContent = lines.join('\n')
      started = -1
      step = 'warm'
      index++
    }
    if (index >= SCENES.length) {
      console.log(`bench\n${lines.join('\n')}`)
      return
    }
    if (step === 'warm') {
      draw(index, 0, 3)
      step = 'frames'
    } else {
      started = now
      draw(index, 3, frames)
      step = 'alone'
    }
    requestAnimationFrame(tick)
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
        Intro: [0, 1],
        Verse: [2, 3, 7],
        Build: [7, 2],
        Drop: [4, 5, 6, 3],
        Breakdown: [0, 1],
      }
      const options = pool[music.section] ?? [0]
      const choice = options[Math.floor(music.beats / 32) % options.length] ?? 0
      if (choice !== current) {
        next = choice
        mix = music.section === 'Drop' ? 1 : 0.0001
      }
    }
    if (mix > 0) {
      mix = Math.min(1, mix + dt / ((60 / bpm) * 2))
      if (mix >= 1) {
        current = next
        mix = 0
      }
    }
    canvas.width = canvas.clientWidth * devicePixelRatio
    canvas.height = canvas.clientHeight * devicePixelRatio
    engine.frame(music, dt, current, next, mix, [canvas.width, canvas.height])
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

if (MODE.startsWith('sheet')) sheet()
else if (MODE === 'bench') bench()
else live()
