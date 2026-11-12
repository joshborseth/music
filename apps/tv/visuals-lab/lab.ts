/*
 * The visuals lab: the TV's shaders and render passes, driven by a made-up
 * song (or a real audio file), so scenes can be tuned in a browser.
 *
 * The passes match `apps/tv/src/visuals/gpu.rs`: each scene draws into its
 * own pair of textures (feedback), the bright parts are blurred at a
 * quarter size, and `final.glsl` puts it together on the screen.
 */

declare const SHADERS: Readonly<Record<string, string>>
declare const MODE: string

interface SceneDef {
  readonly name: string
  readonly file: string
  readonly points: boolean
}

const SCENES: ReadonlyArray<SceneDef> = [
  { name: 'Liquid', file: 'liquid.glsl', points: false },
  { name: 'Ink', file: 'ink.glsl', points: false },
  { name: 'Kaleido', file: 'kaleido.glsl', points: false },
  { name: 'Terrain', file: 'terrain.glsl', points: false },
  { name: 'Chrome', file: 'chrome.glsl', points: false },
  { name: 'Tunnel', file: 'tunnel.glsl', points: false },
  { name: 'Halo', file: 'halo.glsl', points: false },
  { name: 'Particles', file: 'particles.glsl', points: true },
]

const BANDS = 48
const HISTORY_ROWS = 128
const HISTORY_RATE = 32
const WAVE = 512
const COVER = 256
const GRID = 160

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
  shaderText(name)
const VERTEX = VERSION + shaderText('fullscreen.vert')

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
          VERSION + shaderText('common.glsl') + shaderText('particles.vert'),
          VERSION + shaderText('common.glsl') + shaderText('particles.frag'),
        )
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
  }

  const fullscreen = () => gl.drawArrays(gl.TRIANGLES, 0, 3)

  const drawScene = (scene: Scene, music: Music) => {
    const [read, write] = scene.targets
    gl.bindFramebuffer(gl.FRAMEBUFFER, write.framebuffer)
    gl.viewport(0, 0, write.width, write.height)
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

  /** One frame: scene `a`, dissolving into `b` by `mix`. */
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
    const sceneA = scenes[a]
    const sceneB = mix > 0 ? scenes[b] : undefined
    if (sceneA === undefined) return
    drawScene(sceneA, music)
    if (sceneB !== undefined) drawScene(sceneB, music)
    const outA = sceneA.targets[0]
    const outB = (sceneB ?? sceneA).targets[0]
    if (bright !== null && blur !== null) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, bloomA.framebuffer)
      gl.viewport(0, 0, bloomA.width, bloomA.height)
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
        gl.bindFramebuffer(gl.FRAMEBUFFER, to.framebuffer)
        gl.viewport(0, 0, to.width, to.height)
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
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      gl.viewport(0, 0, screen[0], screen[1])
      gl.useProgram(final.program)
      setMusic(final, music, screen, sceneA)
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
  }

  return { frame, setCover, scenes }
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
  const width = 320
  const height = 180
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
else live()
