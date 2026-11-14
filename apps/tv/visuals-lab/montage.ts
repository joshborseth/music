/*
 * The Montage scene in the lab: the song's own pictures, cut on the beat.
 * `makeMontage` keeps the atlas texture (unit 9, `uMontage`) and the cutter,
 * the same as the TV's `montage.rs`, and sets the scene's uniforms each
 * frame. Without a real montage it shows a made-up one (`madeUpMontage`):
 * painted stand-ins for a music video's frames, dark and calm to bright
 * and busy. `labMontage` (the `montage` page) loads a real one from the
 * server's JSON and JPEG and renders contact sheets of chosen moments.
 */

import { type Cues, FAR } from './moments.ts'

/** What the server says about a montage (`TvMontage`). */
export interface MontageMeta {
  readonly videoId: string
  readonly source: 'Video' | 'Artist'
  readonly columns: number
  readonly rows: number
  readonly cellWidth: number
  readonly cellHeight: number
  readonly frames: ReadonlyArray<{
    readonly brightness: number
    readonly busyness: number
  }>
}

/** What the cutter needs from the lab's music: a subset of `Music`. */
export interface MontageMusic {
  readonly time: number
  readonly beats: number
  readonly beatSeconds: number
  readonly intensity: number
  readonly energy: number
  readonly drop: number
  readonly section: string
  readonly parts: { readonly fill: number; readonly stop: number }
  /** The song's ceiling and choreography (moments.ts), when it has them. */
  readonly ceiling?: number
  readonly cue?: Cues
  /** A drop landed this frame (a real song says so). */
  readonly dropLanded?: boolean
}

/** The grades `montage.glsl` knows (montage.rs). */
const DUOTONE = 0
const TRITONE = 1
const HALFTONE = 2
const POSTER = 3
const SHORTEST_CUT = 0.16
const FLASH_EVERY = 0.34
const BURST_BEATS = 8
const BIG_LANDING = 0.5

/** Whether the screen strobes now (`montage::strobing`). */
const strobing = (music: MontageMusic): boolean => {
  const t = Math.min(1, Math.max(0, ((music.ceiling ?? 1) - 0.35) / 0.55))
  return (music.cue?.strobe ?? false) && t * t * (3 - 2 * t) > 0.3
}
const MONTAGE_UNIT = 9

/** The TV's `motion::hash` and `unit`. */
const hash = (input: number): number => {
  let x = input >>> 0
  x ^= x >>> 16
  x = Math.imul(x, 0x7feb352d)
  x ^= x >>> 15
  x = Math.imul(x, 0x846ca68b)
  x ^= x >>> 16
  return x >>> 0
}
const unit = (x: number): number => (hash(x) >>> 8) / (1 << 24)

interface Picture {
  readonly brightRank: number
  readonly busyRank: number
  readonly brightness: number
}

const pictures = (meta: MontageMeta): ReadonlyArray<Picture> => {
  const rank = (values: ReadonlyArray<number>) => {
    const last = Math.max(values.length, 2) - 1
    return values.map(
      mine => values.filter(other => other < mine).length / last,
    )
  }
  const bright = rank(meta.frames.map(frame => frame.brightness))
  const busy = rank(meta.frames.map(frame => frame.busyness))
  return meta.frames.map((_, index) => ({
    brightRank: bright[index] ?? 0,
    busyRank: busy[index] ?? 0,
    brightness: meta.frames[index]?.brightness ?? 0.2,
  }))
}

interface Cut {
  readonly picture: number
  readonly at: number
  readonly length: number
  readonly from: readonly [number, number, number]
  readonly to: readonly [number, number, number]
  readonly strength: number
  readonly look: number
  readonly strips: number
}

type Vec4 = [number, number, number, number]

export interface MontageShot {
  readonly grid: Vec4
  readonly a: Vec4
  readonly b: Vec4
  readonly cut: Vec4
  readonly mix: Vec4
  readonly tone: Vec4
}

const camera = (cut: Cut, time: number): Vec4 => {
  const t = Math.min(
    1,
    Math.max(0, (time - cut.at) / Math.max(cut.length, 0.1)),
  )
  const eased = t * t * (3 - 2 * t)
  const at = (i: 0 | 1 | 2) => cut.from[i] + (cut.to[i] - cut.from[i]) * eased
  return [cut.picture, at(0), at(1), at(2)]
}

/** The TV's `montage::Cutter`. */
const makeCutter = () => {
  let seed = 1
  let current: Cut | undefined
  let previous: Cut | undefined
  let recent: Array<number> = []
  let cuts = 0
  let lastBeats = 0
  let burstUntil = Number.NEGATIVE_INFINITY
  let lastFlash = Number.NEGATIVE_INFINITY
  let lastSince = FAR
  let lastDrop = 0
  let song: string | undefined

  const random = (salt: number) =>
    unit((hash(seed) + Math.imul(cuts, 7919) + salt) >>> 0)

  const pace = (music: MontageMusic): number | undefined => {
    if (music.parts.stop > 0.5) return undefined
    if (music.beats < burstUntil || music.parts.fill > 0.5 || strobing(music))
      return 0.5
    if (
      music.intensity > 0.72 ||
      music.drop > 0.25 ||
      (music.cue?.climax ?? 0) > 0
    )
      return 1
    if (music.intensity > 0.45) return 2
    if (music.intensity > 0.2) return 4
    return 8
  }

  const cut = (music: MontageMusic, ranks: ReadonlyArray<Picture>) => {
    const count = ranks.length
    if (count === 0) return
    const burst = music.beats < burstUntil
    const intensity = Math.min(1, Math.max(0, music.intensity))
    const strobe = strobing(music)
    const target =
      burst || strobe || (music.cue?.climax ?? 0) > 0 ? 1 : intensity
    const remember = Math.min(16, Math.max(1, Math.floor(count / 2)))
    let best = 0
    let bestCost = Number.POSITIVE_INFINITY
    ranks.forEach((picture, index) => {
      const fit =
        Math.abs(picture.busyRank - (0.25 + 0.75 * target)) +
        0.6 * Math.abs(picture.brightRank - (0.35 + 0.55 * target))
      const ago = recent.slice(-remember).reverse().indexOf(index)
      const lately = ago < 0 ? 0 : 2 - ago / remember
      const cost = 1.5 * fit + lately + 0.3 * random(index + 1)
      if (cost < bestCost) {
        bestCost = cost
        best = index
      }
    })
    const beatsApart = pace(music) ?? 4
    const calm = beatsApart >= 4
    const length = Math.max(0.5, beatsApart * Math.max(music.beatSeconds, 0.2))
    const zoomFrom = calm ? 1.05 + 0.1 * random(101) : 1.12 + 0.08 * random(101)
    const zoomTo = calm ? zoomFrom + 0.12 + 0.1 * random(102) : zoomFrom + 0.03
    const reach = (zoom: number, salt: number) =>
      (random(salt) * 2 - 1) * (1 - 1 / zoom) * 0.5
    // As `Cutter::cut`: no cut lights up while the screen flashes.
    const flash =
      music.time - lastFlash >= FLASH_EVERY &&
      !strobe &&
      (music.cue?.until ?? FAR) >= FLASH_EVERY
    if (flash) lastFlash = music.time
    const strength = !flash
      ? 0
      : burst
        ? 1
        : (0.25 + 0.75 * intensity) * (calm ? 0.4 : 1)
    let group = 0
    for (const char of music.section) group = hash(group ^ char.charCodeAt(0))
    const base =
      hash((seed ^ Math.imul(group, 31)) >>> 0) % 2 === 0 ? DUOTONE : TRITONE
    let look = base
    let strips = 1
    if (burst) {
      look = [HALFTONE, POSTER, TRITONE, DUOTONE][cuts % 4] ?? base
      strips = [1, 2, 3, 1, 2][cuts % 5] ?? 1
    } else if (intensity > 0.6) {
      look = cuts % 6 === 2 ? HALFTONE : cuts % 6 === 5 ? POSTER : base
      strips = random(107) < 0.18 ? 2 : 1
    } else if (intensity > 0.4 && cuts % 5 === 4) {
      look = POSTER
    }
    previous = current
    current = {
      picture: best,
      at: music.time,
      length,
      from: [reach(zoomFrom, 103), reach(zoomFrom, 104), zoomFrom],
      to: [reach(zoomTo, 105), reach(zoomTo, 106), zoomTo],
      strength,
      look,
      strips,
    }
    recent.push(best)
    if (recent.length > 32) recent.shift()
    cuts++
  }

  return (
    music: MontageMusic,
    meta: MontageMeta,
    ranks: ReadonlyArray<Picture>,
  ): MontageShot => {
    if (song !== meta.videoId) {
      seed = 17
      for (const char of meta.videoId)
        seed = hash((seed ^ char.charCodeAt(0)) >>> 0)
      song = meta.videoId
      current = undefined
      previous = undefined
      recent = []
      cuts = 0
      lastBeats = music.beats
      burstUntil = Number.NEGATIVE_INFINITY
      lastFlash = Number.NEGATIVE_INFINITY
      lastSince = FAR
    }
    // A real song says where a drop lands; the made-up one, where it leaps.
    const landed =
      music.dropLanded ?? (music.drop > 0.85 && lastDrop < music.drop - 0.3)
    lastDrop = music.drop
    // A build's landing: the choreography's latest landing starting over.
    const since = music.cue?.since ?? FAR
    const landing = since < lastSince
    lastSince = since
    if (landed || landing) lastFlash = music.time
    if (landed || (landing && (music.cue?.landed ?? 0) >= BIG_LANDING))
      burstUntil = music.beats + BURST_BEATS
    const sinceCut =
      current === undefined ? Number.POSITIVE_INFINITY : music.time - current.at
    const beatsApart = pace(music)
    const crossed =
      beatsApart !== undefined &&
      Math.floor(music.beats / beatsApart) !==
        Math.floor(lastBeats / beatsApart) &&
      music.beats > lastBeats
    const stale = sinceCut > 12 && music.parts.stop < 0.5
    if (
      current === undefined ||
      landing ||
      ((crossed || landed || stale) && sinceCut >= SHORTEST_CUT)
    ) {
      cut(music, ranks)
    }
    lastBeats = music.beats
    const shown = current
    if (shown === undefined) {
      return {
        grid: [1, 1, 0, 1],
        a: [0, 0, 0, 1],
        b: [0, 0, 0, 1],
        cut: [0, 0, 0, 1],
        mix: [0, 0, 0, 0],
        tone: [1, 1, 0, 0],
      }
    }
    const before = previous ?? shown
    const intensity = Math.min(1, Math.max(0, music.intensity))
    const burst = music.beats < burstUntil
    const echo = Math.min(
      0.85,
      Math.max(
        0,
        0.32 - 0.26 * intensity + 0.5 * music.parts.fill + (burst ? 0.1 : 0),
      ),
    )
    const barsOn = burst || ((Math.floor(music.beats / 4) % 2) + 2) % 2 < 1
    const spectrum = barsOn
      ? Math.min(1, Math.max(0, (intensity - 0.55) * 2.5)) *
        (0.5 + 0.5 * music.energy)
      : 0
    const target = 0.26 + 0.08 * intensity
    const gain = (cut: Cut) =>
      Math.min(
        2.2,
        Math.max(
          0.7,
          target / Math.max(ranks[cut.picture]?.brightness ?? target, 0.03),
        ),
      )
    return {
      tone: [
        gain(shown),
        gain(before),
        (0.5 * meta.columns) / (meta.columns * meta.cellWidth),
        (0.5 * meta.rows) / (meta.rows * meta.cellHeight),
      ],
      grid: [
        meta.columns,
        meta.rows,
        meta.frames.length,
        meta.source === 'Video' ? meta.cellWidth / meta.cellHeight : 1,
      ],
      a: camera(shown, music.time),
      b: camera(before, music.time),
      cut: [music.time - shown.at, shown.strength, shown.look, shown.strips],
      mix: [echo, 0.04 + 0.16 * intensity, spectrum, 0.5 - 0.36 * intensity],
    }
  }
}

/**
 * A made-up music video: 24 painted frames, from dark, still night scenes
 * to bright, busy crowds of shapes, each in its own colors.
 */
export const madeUpMontage = (): {
  meta: MontageMeta
  image: HTMLCanvasElement
} => {
  const columns = 8
  const rows = 3
  const width = 320
  const height = 180
  const canvas = document.createElement('canvas')
  canvas.width = columns * width
  canvas.height = rows * height
  const context = canvas.getContext('2d')
  const frames: Array<{ brightness: number; busyness: number }> = []
  for (let index = 0; index < columns * rows; index++) {
    const busy = (index % 6) / 5
    const bright = ((index * 7) % 10) / 10
    frames.push({ brightness: 0.1 + 0.5 * bright, busyness: busy })
    if (context === null) continue
    const x = (index % columns) * width
    const y = Math.floor(index / columns) * height
    const hue = (index * 47) % 360
    const sky = context.createLinearGradient(x, y, x, y + height)
    sky.addColorStop(0, `hsl(${hue}, 60%, ${8 + 40 * bright}%)`)
    sky.addColorStop(1, `hsl(${(hue + 40) % 360}, 70%, ${4 + 20 * bright}%)`)
    context.fillStyle = sky
    context.fillRect(x, y, width, height)
    // A figure, as in a performance shot.
    context.fillStyle = `hsl(${(hue + 180) % 360}, 30%, ${10 + 50 * bright}%)`
    context.beginPath()
    context.ellipse(
      x + width * (0.3 + (0.4 * ((index * 3) % 5)) / 4),
      y + height * 0.42,
      22,
      28,
      0,
      0,
      Math.PI * 2,
    )
    context.fill()
    context.fillRect(
      x + width * (0.3 + (0.4 * ((index * 3) % 5)) / 4) - 34,
      y + height * 0.58,
      68,
      height * 0.42,
    )
    // Lights and shapes, the more the busier.
    for (let shape = 0; shape < 4 + busy * 60; shape++) {
      const sx = x + unit(index * 1000 + shape) * width
      const sy = y + unit(index * 1000 + shape + 500) * height
      const size = 3 + unit(index * 2000 + shape) * (busy > 0.5 ? 18 : 40)
      context.fillStyle = `hsla(${(hue + shape * 23) % 360}, 90%, ${40 + 50 * unit(shape + index)}%, ${0.4 + 0.5 * busy})`
      context.fillRect(sx, sy, size, size * (0.3 + unit(shape * 7 + index)))
    }
  }
  return {
    meta: {
      videoId: 'made-up',
      source: 'Video',
      columns,
      rows,
      cellWidth: width,
      cellHeight: height,
      frames,
    },
    image: canvas,
  }
}

interface UniformProgram {
  readonly uniforms: ReadonlyMap<string, WebGLUniformLocation>
}

/** The montage's texture and cutter for one engine. */
export const makeMontage = (gl: WebGL2RenderingContext) => {
  const texture = gl.createTexture()
  let meta: MontageMeta | undefined
  let ranks: ReadonlyArray<Picture> = []
  const cutter = makeCutter()
  let shot: MontageShot | undefined
  let shotTime = Number.NaN

  const setAtlas = (next: MontageMeta, image: TexImageSource) => {
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, image)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    meta = next
    ranks = pictures(next)
  }

  const madeUp = madeUpMontage()
  setAtlas(madeUp.meta, madeUp.image)

  /** Bind the atlas and set this frame's uniforms on `program`. */
  const bind = (program: UniformProgram, music: MontageMusic) => {
    if (!program.uniforms.has('uMontage') || meta === undefined) return
    // Once a frame, as the TV does.
    if (shot === undefined || shotTime !== music.time) {
      shot = cutter(music, meta, ranks)
      shotTime = music.time
    }
    gl.activeTexture(gl.TEXTURE0 + MONTAGE_UNIT)
    gl.bindTexture(gl.TEXTURE_2D, texture)
    const at = program.uniforms.get('uMontage')
    if (at !== undefined) gl.uniform1i(at, MONTAGE_UNIT)
    const values: Array<[string, Vec4]> = [
      ['uMontageGrid', shot.grid],
      ['uMontageA', shot.a],
      ['uMontageB', shot.b],
      ['uMontageCut', shot.cut],
      ['uMontageMix', shot.mix],
      ['uMontageTone', shot.tone],
    ]
    for (const [name, value] of values) {
      const location = program.uniforms.get(name)
      if (location !== undefined) gl.uniform4f(location, ...value)
    }
  }

  return { setAtlas, bind, shot: () => shot }
}

// PAGE --------------------------------------------------------------------

/** What the montage page needs from the lab's engine. */
interface LabEngine<M> {
  readonly frame: (
    music: M,
    dt: number,
    a: number,
    b: number,
    mix: number,
    screen: [number, number],
  ) => void
  readonly setCover: (source: HTMLCanvasElement | HTMLImageElement) => void
  readonly setSide: (on: boolean) => void
  readonly clearScenes: () => void
  readonly montage: {
    readonly setAtlas: (meta: MontageMeta, image: TexImageSource) => void
  }
}

interface RenderOptions {
  /** The server's `TvMontage`, and its atlas (a URL; data: works). */
  readonly meta?: MontageMeta
  readonly atlas?: string
  readonly cover?: string
  /** Seconds into the made-up song to show. */
  readonly moments: ReadonlyArray<number>
  readonly width?: number
  readonly height?: number
  readonly side?: boolean
  readonly title?: string
}

const loadImage = async (url: string): Promise<HTMLImageElement> => {
  const image = new Image()
  image.src = url
  await image.decode()
  return image
}

/**
 * The `montage` page: `labMontage.render(options)` plays the made-up song
 * through the Montage scene, with a real montage when given one, and
 * returns a contact sheet (a JPEG data URL) of the moments asked for.
 */
export const montagePage = <M extends MontageMusic>(deps: {
  readonly makeEngine: (
    gl: WebGL2RenderingContext,
    width: number,
    height: number,
  ) => LabEngine<M>
  readonly song: () => (time: number) => M
  readonly cover: () => HTMLCanvasElement
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
  const render = async (options: RenderOptions): Promise<string> => {
    const width = options.width ?? 480
    const height = options.height ?? 270
    canvas.width = width
    canvas.height = height
    const engine = deps.makeEngine(
      gl,
      Math.round(width * 0.85),
      Math.round(height * 0.85),
    )
    engine.setCover(
      options.cover === undefined
        ? deps.cover()
        : await loadImage(options.cover),
    )
    engine.setSide(options.side ?? false)
    if (options.meta !== undefined && options.atlas !== undefined) {
      engine.montage.setAtlas(options.meta, await loadImage(options.atlas))
    }
    engine.clearScenes()
    const song = deps.song()
    const wanted = [...options.moments].sort((a, b) => a - b)
    const last = wanted.at(-1) ?? 0
    const tiles: Array<{ image: HTMLCanvasElement; caption: string }> = []
    const step = 1 / 30
    for (let frame = 0; frame * step <= last + 1e-6; frame++) {
      const time = frame * step
      const music = song(time)
      engine.frame(music, step, deps.scene, deps.scene, 0, [width, height])
      while (wanted.length > 0 && (wanted[0] ?? 0) <= time + 1e-6) {
        wanted.shift()
        const tile = document.createElement('canvas')
        tile.width = width
        tile.height = height
        tile.getContext('2d')?.drawImage(canvas, 0, 0)
        const phase = music.beats - Math.floor(music.beats)
        tiles.push({
          image: tile,
          caption: `${time.toFixed(2)}s ${music.section} beat ${Math.floor(music.beats)}+${phase.toFixed(2)} int ${music.intensity.toFixed(2)} drop ${music.drop.toFixed(2)}`,
        })
      }
    }
    const columns = Math.min(tiles.length, 3)
    const rows = Math.ceil(tiles.length / columns)
    const gap = 8
    const caption = 18
    const header = 26
    const out = document.createElement('canvas')
    out.width = columns * (width + gap) + gap
    out.height = header + rows * (height + caption + gap) + gap
    const context = out.getContext('2d')
    if (context === null) throw new Error('no 2D canvas')
    context.fillStyle = '#0b0d12'
    context.fillRect(0, 0, out.width, out.height)
    context.fillStyle = '#ece9f5'
    context.font = '600 14px system-ui, sans-serif'
    context.fillText(
      options.title ?? options.meta?.videoId ?? 'made-up montage',
      gap,
      18,
    )
    tiles.forEach(({ image, caption: text }, index) => {
      const x = gap + (index % columns) * (width + gap)
      const y = header + Math.floor(index / columns) * (height + caption + gap)
      context.drawImage(image, x, y)
      context.fillStyle = '#8c88a0'
      context.font = '11px ui-monospace, monospace'
      context.fillText(text, x, y + height + 13)
    })
    return out.toDataURL('image/jpeg', 0.88)
  }
  Object.assign(globalThis, { labMontage: { render } })
  status.textContent = 'labMontage.render({ meta, atlas, cover, moments })'
}
