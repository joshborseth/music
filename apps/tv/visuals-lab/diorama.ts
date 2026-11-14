/*
 * The Diorama scene in the lab: the cover's depth (a made-up one for the
 * made-up cover, or a real one from the server's `/tv/depth`), the camera
 * and the shatter worked out once a frame, and the relief drawn as a mesh
 * with a depth buffer before the backdrop. All as `apps/tv/src/visuals/
 * diorama.rs` and `gpu.rs` do it; keep them in step.
 *
 * `dioramaPage` is a page of its own (`dist/diorama.html`): a script
 * (Playwright) calls `labDiorama.render` with a cover and its depth for
 * contact sheets of the scene through the made-up song.
 */

/** The relief's grid (`diorama.vert`, `diorama::COLUMNS`/`ROWS`). */
const COLUMNS = 66 + 2 * 32
const ROWS = 66 + 2 * 12
/** Whole, a triangle strip a row; shattering, three points a triangle. */
const STRIP_POINTS = ROWS * (2 * (COLUMNS + 1) + 2) - 2
const SHARD_POINTS = COLUMNS * ROWS * 6
/** `RELIEF` in diorama.glsl: how far the nearest part stands out. */
const RELIEF = 0.62
const SHATTER_BEATS = 8
const NEAREST_SHARE = 0.08
const SIDE = 256

type Vec3 = [number, number, number]

/** The music the camera and the shatter follow: a part of the lab's `Music`. */
export interface DioramaMusic {
  readonly time: number
  readonly beats: number
  readonly tension: number
  readonly drop: number
  readonly parts: { readonly snare: number }
  readonly dropLanded?: boolean
}

// DEPTH ----------------------------------------------------------------

/**
 * A depth for the lab's made-up cover (`madeUpCover`): its gradient far
 * back, falling away up the picture, the sun a dome near you, the bar
 * across it nearer, and the word nearest. Near is bright, as the server's.
 */
export const madeUpDepth = (): Uint8Array => {
  const canvas = document.createElement('canvas')
  canvas.width = SIDE
  canvas.height = SIDE
  const context = canvas.getContext('2d')
  if (context === null) return new Uint8Array(SIDE * SIDE).fill(128)
  const back = context.createLinearGradient(0, 0, 0, SIDE)
  back.addColorStop(0, '#101010')
  back.addColorStop(1, '#585858')
  context.fillStyle = back
  context.fillRect(0, 0, SIDE, SIDE)
  context.filter = 'blur(3px)'
  const sun = context.createRadialGradient(
    SIDE * 0.62,
    SIDE * 0.38,
    0,
    SIDE * 0.62,
    SIDE * 0.38,
    SIDE * 0.2,
  )
  sun.addColorStop(0, '#f0f0f0')
  sun.addColorStop(0.8, '#b0b0b0')
  sun.addColorStop(1, '#909090')
  context.fillStyle = sun
  context.beginPath()
  context.arc(SIDE * 0.62, SIDE * 0.38, SIDE * 0.2, 0, Math.PI * 2)
  context.fill()
  context.fillStyle = '#a0a0a0'
  context.fillRect(SIDE * 0.1, SIDE * 0.7, SIDE * 0.8, SIDE * 0.06)
  context.fillStyle = '#ffffff'
  context.font = `bold ${SIDE * 0.14}px system-ui`
  context.fillText('MUSIC', SIDE * 0.1, SIDE * 0.92)
  return redOf(context.getImageData(0, 0, SIDE, SIDE).data)
}

/** A real depth map (the server's PNG), at the cover's size. */
export const depthOf = (
  source: HTMLImageElement | HTMLCanvasElement,
): Uint8Array => {
  const canvas = document.createElement('canvas')
  canvas.width = SIDE
  canvas.height = SIDE
  const context = canvas.getContext('2d')
  if (context === null) return new Uint8Array(SIDE * SIDE).fill(128)
  context.drawImage(source, 0, 0, SIDE, SIDE)
  return redOf(context.getImageData(0, 0, SIDE, SIDE).data)
}

const smoothstep = (from: number, to: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - from) / (to - from)))
  return t * t * (3 - 2 * t)
}

const redOf = (rgba: Uint8ClampedArray): Uint8Array => {
  const out = new Uint8Array(SIDE * SIDE)
  for (let i = 0; i < out.length; i++) out[i] = rgba[i * 4] ?? 0
  return out
}

/** The nearest subject, as `diorama::nearest_subject`: x, y up, depth. */
export const depthFocus = (pixels: Uint8Array): Vec3 => {
  if (pixels.length !== SIDE * SIDE) return [0.5, 0.5, 0.5]
  const counts = new Array<number>(256).fill(0)
  for (const value of pixels) counts[value] = (counts[value] ?? 0) + 1
  const wanted = Math.floor(pixels.length * NEAREST_SHARE)
  let seen = 0
  let threshold = 255
  for (let value = 255; value >= 0; value--) {
    seen += counts[value] ?? 0
    if (seen >= wanted) {
      threshold = value
      break
    }
  }
  let x = 0
  let y = 0
  let depth = 0
  let sum = 0
  pixels.forEach((value, index) => {
    if (value < threshold) return
    const across = ((index % SIDE) + 0.5) / SIDE
    const down = (Math.floor(index / SIDE) + 0.5) / SIDE
    const middle =
      1 -
      smoothstep(
        0.25,
        0.48,
        Math.max(Math.abs(across - 0.5), Math.abs(down - 0.5)),
      )
    const weight = (1 + value - threshold) ** 2 * middle
    x += weight * across
    y += weight * down
    depth += weight * value
    sum += weight
  })
  if (sum <= 1e-3) return [0.5, 0.5, 0.5]
  return [x / sum, 1 - y / sum, depth / sum / 255]
}

// SHATTER AND CAMERA --------------------------------------------------------

/** The shatter on a drop, as `diorama::Shatter`. */
export const makeShatter = () => {
  let landed: [number, number] | null = null
  let lastDrop = 0
  return {
    /** As `Shatter::hear`: only a drop landing while Diorama shows alone. */
    hear: (music: DioramaMusic, alone: boolean) => {
      // The made-up song says nothing of landing: its drop leaps to 1.
      const landing = music.dropLanded ?? (music.drop > 0.9 && lastDrop < 0.5)
      lastDrop = music.drop
      if (landing && alone)
        landed = [music.beats, Math.min(1, Math.max(0, music.drop))]
    },
    clear: () => {
      landed = null
    },
    now: (music: DioramaMusic): [number, number] => {
      if (landed === null) return [0, 0]
      const through = (music.beats - landed[0]) / SHATTER_BEATS
      return through >= 0 && through < 1 ? [through, landed[1]] : [0, 0]
    },
  }
}

const FOCAL = 2.3
const NEAR = 0.05
const FAR = 12

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]
const dot = (a: Vec3, b: Vec3): number =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const scale = (a: Vec3, by: number): Vec3 => [a[0] * by, a[1] * by, a[2] * by]
const normalize = (a: Vec3): Vec3 => {
  const length = Math.max(Math.sqrt(dot(a, a)), 1e-6)
  return [a[0] / length, a[1] / length, a[2] / length]
}

/** Projection times view, column by column, as `diorama::view_matrix`. */
const viewMatrix = (eye: Vec3, at: Vec3, aspect: number): Float32Array => {
  const forward = normalize(sub(at, eye))
  const right = normalize(cross(forward, [0, 1, 0]))
  const up = cross(right, forward)
  const xScale = FOCAL / Math.max(aspect, 1e-3)
  const depthScale = (FAR + NEAR) / (FAR - NEAR)
  const depthShift = (-2 * FAR * NEAR) / (FAR - NEAR)
  const rows: Array<[Vec3, number]> = [
    [scale(right, xScale), -dot(right, eye) * xScale],
    [scale(up, FOCAL), -dot(up, eye) * FOCAL],
    [scale(forward, depthScale), -dot(forward, eye) * depthScale + depthShift],
    [forward, -dot(forward, eye)],
  ]
  const columns = new Float32Array(16)
  rows.forEach(([axes, shift], row) => {
    for (let column = 0; column < 3; column++)
      columns[column * 4 + row] = axes[column] ?? 0
    columns[12 + row] = shift
  })
  return columns
}

/** The camera, as `diorama::Camera::new`. */
export const dioramaCamera = (
  music: DioramaMusic,
  seed: number,
  focus: Vec3,
  aspect: number,
  hit: number,
): { view: Float32Array; eye: [number, number, number, number] } => {
  const TAU = Math.PI * 2
  const bars = music.beats / 4
  const snare = music.parts.snare
  const yaw =
    0.22 * Math.sin((TAU * bars) / 8 + seed * TAU) +
    0.08 * Math.sin(music.time * 0.07) +
    0.07 * snare * Math.sin(snare * 18)
  const pitch = -0.05 + 0.1 * Math.sin((TAU * bars) / 12 + seed * 5)
  const tension = Math.min(1, Math.max(0, music.tension))
  const home: Vec3 = [0, 0, RELIEF * 0.35]
  const subject: Vec3 = [focus[0] * 2 - 1, focus[1] * 2 - 1, RELIEF * focus[2]]
  const toward = 0.15 + 0.7 * tension
  const at: Vec3 = [
    home[0] + (subject[0] - home[0]) * toward,
    home[1] + (subject[1] - home[1]) * toward,
    home[2] + (subject[2] - home[2]) * toward,
  ]
  const distance = 2.25 * (1 - 0.07 * hit) - 0.9 * tension * Math.sqrt(tension)
  const eye: Vec3 = [
    at[0] + distance * Math.sin(yaw) * Math.cos(pitch),
    at[1] + distance * Math.sin(pitch),
    at[2] + distance * Math.cos(yaw) * Math.cos(pitch),
  ]
  return { view: viewMatrix(eye, at, aspect), eye: [...eye, yaw] }
}

// DRAWING ------------------------------------------------------------------

interface DioramaProgram {
  readonly program: WebGLProgram
  readonly uniforms: Map<string, WebGLUniformLocation>
}

/**
 * The scene's own GPU parts: its depth texture, the shatter, and its depth
 * buffer, for the lab's engine (`makeEngine`).
 */
export const makeDiorama = (gl: WebGL2RenderingContext) => {
  const texture = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, texture)
  // Mipmapped: the relief's points read it smoothed (diorama.vert).
  gl.texParameteri(
    gl.TEXTURE_2D,
    gl.TEXTURE_MIN_FILTER,
    gl.LINEAR_MIPMAP_LINEAR,
  )
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  let focus: Vec3 = [0.5, 0.5, 0.5]
  const shatter = makeShatter()
  const buffer = gl.createRenderbuffer()
  let bufferSize = ''

  const setDepth = (pixels: Uint8Array) => {
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.R8,
      SIDE,
      SIDE,
      0,
      gl.RED,
      gl.UNSIGNED_BYTE,
      pixels,
    )
    gl.generateMipmap(gl.TEXTURE_2D)
    focus = depthFocus(pixels)
  }
  setDepth(madeUpDepth())

  /** Its uniforms, for a program that has them. */
  const setUniforms = (
    p: DioramaProgram,
    music: DioramaMusic,
    seed: number,
    res: [number, number],
    hit: number,
  ) => {
    const viewAt = p.uniforms.get('uDioramaView')
    if (viewAt !== undefined) {
      const camera = dioramaCamera(music, seed, focus, res[0] / res[1], hit)
      gl.uniformMatrix4fv(viewAt, false, camera.view)
      const eyeAt = p.uniforms.get('uDioramaEye')
      if (eyeAt !== undefined) gl.uniform4f(eyeAt, ...camera.eye)
    }
    const shatterAt = p.uniforms.get('uDioramaShatter')
    if (shatterAt !== undefined) gl.uniform2f(shatterAt, ...shatter.now(music))
  }

  /**
   * Into `target`: the relief, then while it shatters the backdrop where it
   * left the picture empty, as `Renderer::draw_diorama`. `relief` and
   * `backdrop` set up each program (uniforms, textures) before its draw.
   */
  const draw = (
    target: {
      framebuffer: WebGLFramebuffer
      width: number
      height: number
    },
    music: DioramaMusic,
    relief: () => void,
    backdrop: () => void,
  ) => {
    const shattering = shatter.now(music)[1] > 0
    const size = `${target.width}x${target.height}`
    gl.bindRenderbuffer(gl.RENDERBUFFER, buffer)
    if (size !== bufferSize) {
      gl.renderbufferStorage(
        gl.RENDERBUFFER,
        gl.DEPTH_COMPONENT16,
        target.width,
        target.height,
      )
      bufferSize = size
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer)
    gl.viewport(0, 0, target.width, target.height)
    gl.framebufferRenderbuffer(
      gl.FRAMEBUFFER,
      gl.DEPTH_ATTACHMENT,
      gl.RENDERBUFFER,
      buffer,
    )
    gl.depthMask(true)
    gl.clearDepth(1)
    gl.clearColor(0, 0, 0, 1)
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
    gl.enable(gl.DEPTH_TEST)
    gl.depthFunc(gl.LESS)
    relief()
    if (shattering) gl.drawArrays(gl.TRIANGLES, 0, SHARD_POINTS)
    else gl.drawArrays(gl.TRIANGLE_STRIP, 0, STRIP_POINTS)
    if (shattering) {
      gl.depthFunc(gl.LEQUAL)
      gl.depthMask(false)
      gl.depthRange(1, 1)
      backdrop()
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      gl.depthRange(0, 1)
    }
    gl.invalidateFramebuffer(gl.FRAMEBUFFER, [gl.DEPTH_ATTACHMENT])
    gl.framebufferRenderbuffer(
      gl.FRAMEBUFFER,
      gl.DEPTH_ATTACHMENT,
      gl.RENDERBUFFER,
      null,
    )
    gl.disable(gl.DEPTH_TEST)
    gl.depthMask(true)
  }

  return {
    texture,
    setDepth,
    setUniforms,
    draw,
    hear: shatter.hear,
    clear: shatter.clear,
  }
}

/** The relief's shaders, from the TV's files, as gpu.rs puts them together. */
export const reliefSources = (
  shader: (name: string) => string,
  fragment: (name: string) => string,
): [string, string] => [
  '#version 300 es\n#define DIORAMA_MESH\n' +
    shader('common.glsl') +
    shader('helpers.glsl') +
    shader('diorama.glsl') +
    shader('diorama.vert'),
  fragment('diorama.frag'),
]

// THE PAGE -------------------------------------------------------------------

/** What the page needs from the lab's engine. */
interface PageEngine<M> {
  frame: (
    music: M,
    dt: number,
    a: number,
    b: number,
    mix: number,
    screen: [number, number],
  ) => void
  setCover: (source: HTMLCanvasElement | HTMLImageElement) => void
  setDepth: (pixels: Uint8Array) => void
  clearScenes: () => void
}

interface RenderOptions {
  /** A cover and its depth (URLs); the made-up ones when left out. */
  readonly cover?: string
  readonly depth?: string
  readonly title?: string
  /** Moments of the made-up song, in bars, and what to call each. */
  readonly picks: ReadonlyArray<{
    readonly label: string
    readonly bar: number
  }>
  readonly width?: number
  readonly height?: number
  readonly columns?: number
}

/**
 * `dist/diorama.html`: `labDiorama.render(options)` plays the made-up song
 * into each pick, Diorama alone, and returns a contact sheet (JPEG data
 * URL).
 */
export const dioramaPage = <M extends { readonly section: string }>(deps: {
  readonly makeEngine: (
    gl: WebGL2RenderingContext,
    width: number,
    height: number,
  ) => PageEngine<M>
  readonly madeUpSong: (bpm: number) => (time: number) => M
  readonly madeUpCover: () => HTMLCanvasElement
  readonly scene: number
}) => {
  const status = document.createElement('pre')
  document.body.append(status)
  const canvas = document.createElement('canvas')
  const gl = canvas.getContext('webgl2', {
    preserveDrawingBuffer: true,
    antialias: false,
  })
  if (gl === null) {
    status.textContent = 'No WebGL 2 here.'
    return
  }
  const image = async (url: string) => {
    const loaded = new Image()
    loaded.src = url
    await loaded.decode()
    return loaded
  }
  const render = async (options: RenderOptions): Promise<string> => {
    const width = options.width ?? 640
    const height = options.height ?? 360
    canvas.width = width
    canvas.height = height
    const engine = deps.makeEngine(
      gl,
      Math.round(width * 0.85),
      Math.round(height * 0.85),
    )
    engine.setCover(
      options.cover === undefined
        ? deps.madeUpCover()
        : await image(options.cover),
    )
    engine.setDepth(
      options.depth === undefined
        ? madeUpDepth()
        : depthOf(await image(options.depth)),
    )
    const bpm = 124
    const bar = (60 / bpm) * 4
    const tiles: Array<{ image: HTMLCanvasElement; caption: string }> = []
    for (const pick of options.picks) {
      const song = deps.madeUpSong(bpm)
      engine.clearScenes()
      const at = pick.bar * bar
      // From a bar and a half before, at 30 frames a second.
      const from = Math.max(0, at - bar * 1.5)
      const steps = Math.max(1, Math.round((at - from) * 30))
      let section = ''
      for (let step = 0; step <= steps; step++) {
        const music = song(from + ((at - from) * step) / steps)
        section = music.section
        engine.frame(music, 1 / 30, deps.scene, deps.scene, 0, [width, height])
      }
      const tile = document.createElement('canvas')
      tile.width = width
      tile.height = height
      tile.getContext('2d')?.drawImage(canvas, 0, 0)
      tiles.push({
        image: tile,
        caption: `${pick.label} · bar ${pick.bar} · ${section}`,
      })
    }
    const columns = options.columns ?? Math.min(tiles.length, 3)
    const rows = Math.ceil(tiles.length / columns)
    const gap = 8
    const caption = 20
    const header = 26
    const out = document.createElement('canvas')
    out.width = columns * (width + gap) + gap
    out.height = header + rows * (height + caption + gap) + gap
    const context = out.getContext('2d')
    if (context === null) throw new Error('no 2D canvas')
    context.fillStyle = '#0b0d12'
    context.fillRect(0, 0, out.width, out.height)
    context.fillStyle = '#ece9f5'
    context.font = '600 15px system-ui, sans-serif'
    context.fillText(options.title ?? 'Diorama', gap, 18)
    tiles.forEach((tile, index) => {
      const x = gap + (index % columns) * (width + gap)
      const y = header + Math.floor(index / columns) * (height + caption + gap)
      context.drawImage(tile.image, x, y)
      context.fillStyle = '#ece9f5'
      context.font = '12px ui-monospace, monospace'
      context.fillText(tile.caption, x, y + height + 14)
    })
    return out.toDataURL('image/jpeg', 0.9)
  }
  Object.assign(globalThis, { labDiorama: { render } })
  status.textContent = 'labDiorama: render(options)'
}
