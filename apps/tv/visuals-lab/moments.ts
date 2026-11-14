/*
 * The moments in the lab: the song's choreography (the TV's `cues.rs`),
 * the picture's values for builds, landings, strobes, and the glitch (the
 * TV's `Screen` in motion.rs), the changes of scene `final.glsl` draws
 * from the frozen frame (`transition.rs`), and a page to look at them:
 * each change at several points of its way, a whole build into its drop,
 * the glitch, and what each change costs.
 *
 *   dist/moments.html?show=transitions   each change, step by step
 *   dist/moments.html?show=build         a build, its inhale, the landing
 *   dist/moments.html?show=glitch        a fill, a strobe, the climax
 *   dist/moments.html?show=bench         a change's cost against a scene's
 */

// CUES ---------------------------------------------------------------------

/** "No landing coming" or "none yet", in seconds: the TV's `cues::FAR`. */
export const FAR = 99

/** The choreography in one frame: the TV's `cues::Cues`. */
export interface Cues {
  readonly until: number
  readonly build: number
  readonly strength: number
  readonly since: number
  readonly landed: number
  readonly climax: number
  readonly strobe: boolean
}

export const NO_CUES: Cues = {
  until: FAR,
  build: 0,
  strength: 0,
  since: FAR,
  landed: 0,
  climax: 0,
  strobe: false,
}

/** The changes of scene, in the order of `uTransKind` (transition.rs). */
export const TRANSITIONS = [
  'Cut',
  'Shatter',
  'Melt',
  'ZoomThrough',
  'Datamosh',
  'Wipe',
] as const

/** `uTransKind` for a change named `name`; one the lab doesn't know wipes. */
export const transitionCode = (name: string): number => {
  const index = TRANSITIONS.findIndex(kind => kind === name)
  return index < 0 ? TRANSITIONS.length - 1 : index
}

/** A change of scene in one frame: how, and the incoming scene's look. */
export interface SceneChange {
  readonly kind: number
  readonly seed: number
}

// THE PICTURE ----------------------------------------------------------------

type Rgb = [number, number, number]

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x))
const fract = (x: number): number => x - Math.floor(x)

export const smoothstep = (from: number, to: number, x: number): number => {
  const t = clamp01((x - from) / (to - from))
  return t * t * (3 - 2 * t)
}

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

const unit = (x: number): number => (hash(x) >>> 8) / (1 << 24)

/** What the moments read of a frame of music (the lab's `Music`). */
export interface MomentMusic {
  readonly beats: number
  readonly bar: number
  readonly beatSeconds: number
  readonly kick: number
  readonly intensity: number
  readonly energy: number
  readonly drop: number
  readonly tension: number
  readonly ceiling?: number
  readonly cue?: Cues
  readonly parts: {
    readonly snare: number
    readonly stop: number
    readonly fill: number
    readonly chordChange: number
    readonly repeat: number
  }
}

/** How hard the beat hits the picture: the TV's `motion::hit`. */
export const hit = (music: MomentMusic): number =>
  music.kick * (0.3 + 0.7 * smoothstep(0.3, 0.85, music.intensity))

/** The build as the screen shows it, and the landing: the TV's `build_and_landing`. */
export const buildAndLanding = (music: MomentMusic): [number, number] => {
  const cue = music.cue ?? NO_CUES
  const wild = 0.35 + 0.65 * smoothstep(0.35, 0.9, music.ceiling ?? 1)
  const build = cue.build * cue.build * cue.strength * wild
  const land =
    cue.since < FAR
      ? cue.landed *
        wild *
        Math.exp(-cue.since / (0.9 * Math.max(0.2, music.beatSeconds)))
      : 0
  return [build, land]
}

export interface ScreenLook {
  readonly punch: number
  readonly bulge: number
  readonly lift: number
  readonly split: number
  readonly glow: number
  readonly flash: Rgb
  readonly vignette: Rgb
  readonly drain: number
  readonly inhale: number
  readonly glitch: number
  readonly glitchSeed: number
  readonly posterize: number
  readonly hold: boolean
}

/** The most bright flashes a second: the TV's `MOST_FLASHES`. */
const MOST_FLASHES = 3

/**
 * The picture's values, the same at every pixel, once a frame: the TV's
 * `Screen::new` (motion.rs). Keep the two in step.
 */
export const screenLook = (music: MomentMusic, color: Rgb): ScreenLook => {
  const { drop } = music
  const beatHit = hit(music)
  const parts = music.parts
  const cue = music.cue ?? NO_CUES
  const beat = Math.max(0.1, music.beatSeconds)
  const wild = smoothstep(0.35, 0.9, music.ceiling ?? 1)
  const [build, land] = buildAndLanding(music)
  const tension = Math.max(music.tension, build)
  const bar = 4 * beat
  const coming = cue.until < FAR
  const lastBar = coming && cue.until < bar ? 1 - cue.until / bar : 0
  const rate = !coming || cue.until >= 2 * bar ? 1 : cue.until >= bar ? 2 : 4
  const quicken = Math.exp(-fract(music.beats * rate) * 5) * build
  const half = 0.5 * beat
  const inhale =
    coming && cue.until < half
      ? smoothstep(half, 0.55 * half, cue.until) *
        (0.4 + 0.6 * cue.strength) *
        (0.3 + 0.7 * wild)
      : 0
  const climax = cue.climax * wild

  let strobeFlash = 0
  let strobeDim = 0
  if (cue.strobe && wild > 0.3) {
    const inBar = ((Math.floor(music.bar * 4) % 4) + 4) % 4
    const pulse = Math.exp(-fract(music.beats) * beat * 16) * wild
    const brightEvery = 2 / (4 * beat) > MOST_FLASHES ? 4 : 2
    if (inBar % brightEvery === 0) strobeFlash = pulse * 0.5
    else if (inBar % 2 === 1) strobeDim = pulse * 0.55
  }

  const beatIndex = Math.floor(music.beats)
  const burst =
    ((beatIndex % 8) + 8) % 8 === 7 || unit((beatIndex >>> 0) ^ 0x9e37) < 0.18
      ? Math.exp(-fract(music.beats) * 2.5)
      : 0
  const fill = parts.fill * smoothstep(0.4, 0.8, music.intensity)
  const edge = lastBar * cue.strength
  const glitch =
    Math.max(fill * 0.55, edge * 0.85, climax * burst * 0.8) *
    (0.3 + 0.7 * wild)
  const sixteenth = Math.floor(music.beats * 4)
  const posterize = Math.max(edge * edge * 0.8, climax * burst * 0.6) * wild
  const hold =
    parts.stop > 0.5 ||
    (fill > 0.5 && (music.beats * 2) % 2 >= 1) ||
    (edge > 0 && wild > 0.5 && ((sixteenth % 2) + 2) % 2 === 1)

  const held = 1 - 0.8 * parts.stop
  const big = 1 + 0.25 * climax
  const flash = Math.max(drop ** 8 * 0.8, land ** 3 * 0.95) * big + strobeFlash
  return {
    punch:
      1 -
      (0.05 * beatHit +
        0.05 * drop +
        0.16 * build +
        0.025 * quicken +
        0.07 * land) *
        big,
    bulge: (0.08 * beatHit + 0.08 * drop * drop + 0.3 * land * land) * big,
    lift:
      (1 +
        0.4 * beatHit +
        0.45 * drop +
        0.5 * land +
        0.35 * build +
        0.3 * quicken) *
      held *
      big *
      (1 - strobeDim),
    split:
      (0.006 * drop * drop * drop +
        0.0015 * parts.snare * music.intensity +
        0.01 * land * land) *
      big,
    glow:
      (0.3 +
        0.5 * music.energy +
        0.8 * beatHit +
        0.7 * drop +
        0.15 * parts.chordChange +
        0.6 * land) *
      held *
      big *
      (1 + 0.1 * Math.min(parts.repeat, 3)),
    flash: [
      (color[0] + 0.3 * (1 - color[0])) * flash,
      (color[1] + 0.3 * (1 - color[1])) * flash,
      (color[2] + 0.3 * (1 - color[2])) * flash,
    ],
    vignette: [
      Math.max(0.5, 1.05 - 0.4 * tension - 0.25 * build),
      Math.max(0.14, 0.25 - 0.1 * tension - 0.12 * build),
      Math.max(0.08, 0.55 - 0.25 * tension - 0.25 * build),
    ],
    drain: 0.75 * build,
    inhale,
    glitch,
    glitchSeed: unit((sixteenth >>> 0) ^ 0x51ed),
    posterize,
    hold,
  }
}

// THE MADE-UP SONG'S PLAN ----------------------------------------------------

/**
 * The made-up song's choreography (its 32 bars: a build over bars 16 to
 * 20, the drop landing on bar 20, which is the climax to bar 28 and
 * strobes to bar 24), and the drum fill over the second half of bar 19.
 */
export const madeUpCues = (
  beats: number,
  beatSeconds: number,
): { cue: Cues; fill: number } => {
  const bar = beats / 4
  const loop = Math.floor(bar / 32) * 32
  const at = bar - loop
  const barSeconds = beatSeconds * 4
  const inBuild = at >= 16 && at < 20
  const sinceDrop =
    at >= 20 ? (at - 20) * barSeconds : loop > 0 ? (at + 12) * barSeconds : FAR
  return {
    cue: {
      until: inBuild ? (20 - at) * barSeconds : FAR,
      build: inBuild ? (at - 16) / 4 : 0,
      strength: 1,
      since: Math.min(FAR, sinceDrop),
      landed: sinceDrop < FAR ? 1 : 0,
      climax: at >= 20 && at < 28 ? 1 : 0,
      strobe: at >= 20 && at < 24,
    },
    fill: at >= 19.5 && at < 20 ? 1 : 0,
  }
}

// THE PAGE -----------------------------------------------------------------

/** What the page borrows from the lab (lab.ts). */
export interface MomentLab<M> {
  readonly scenes: ReadonlyArray<string>
  readonly makeEngine: (
    gl: WebGL2RenderingContext,
    width: number,
    height: number,
  ) => {
    frame: (
      music: M,
      dt: number,
      a: number,
      b: number,
      mix: number,
      screen: [number, number],
      only?: 'scene' | 'bloom' | 'final' | 'present',
      change?: SceneChange,
    ) => void
    setCover: (source: HTMLCanvasElement) => void
    clearScenes: () => void
  }
  readonly song: (bpm: number) => (time: number) => M
  readonly cover: () => HTMLCanvasElement
}

const element = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Record<string, string> = {},
): HTMLElementTagNameMap[K] => {
  const made = document.createElement(tag)
  for (const [key, value] of Object.entries(attributes))
    made.setAttribute(key, value)
  return made
}

const BPM = 124
const BEAT = 60 / BPM
const BAR = BEAT * 4

/** Contact sheets of the moments, and a bench of what changes cost. */
export const momentsPage = <M>(lab: MomentLab<M>) => {
  const params = new URLSearchParams(location.search)
  const show = params.get('show') ?? 'transitions'
  const scale = Number(params.get('scale') ?? 1)
  const width = Math.round(384 * scale)
  const height = Math.round(216 * scale)
  const root = element('div', { id: 'sheet' })
  root.style.gridTemplateColumns = `repeat(${Number(params.get('columns') ?? 5)}, 1fr)`
  document.body.append(root)
  const canvas = element('canvas')
  canvas.width = width
  canvas.height = height
  const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true })
  if (gl === null) {
    root.textContent = 'No WebGL 2 here.'
    return
  }
  const scene = (name: string) =>
    Math.max(
      0,
      lab.scenes.findIndex(each => each === name),
    )
  const engine = lab.makeEngine(
    gl,
    Math.round(width * 0.85),
    Math.round(height * 0.85),
  )
  engine.setCover(lab.cover())
  const tile = (caption: string) => {
    const copy = element('canvas')
    copy.width = width
    copy.height = height
    copy.getContext('2d')?.drawImage(canvas, 0, 0)
    const figure = element('figure')
    const label = element('figcaption')
    label.textContent = caption
    figure.append(copy, label)
    root.append(figure)
  }
  const screen: [number, number] = [width, height]
  const dt = 1 / 60

  if (show === 'transitions') {
    // Each change, from Halo to Tunnel in the drop, at five points.
    const from = scene(params.get('from') ?? 'Halo')
    const to = scene(params.get('to') ?? 'Tunnel')
    const points = [0, 0.12, 0.3, 0.55, 0.8]
    const start = BAR * 21
    for (const name of TRANSITIONS.slice(1)) {
      for (const point of points) {
        engine.clearScenes()
        const song = lab.song(BPM)
        // The old scene plays a second, then freezes; the new one comes
        // in, drawing every frame, as the change runs to this point.
        for (let step = 0; step < 60; step++)
          engine.frame(song(start - 1 + step * dt), dt, from, from, 0, screen)
        const frames = Math.max(1, Math.round(point * 60))
        for (let step = 1; step <= frames; step++) {
          const mix = point * (step / frames)
          engine.frame(
            song(start + step * dt),
            dt,
            from,
            to,
            Math.max(mix, 1e-4),
            screen,
            undefined,
            { kind: transitionCode(name), seed: 0.37 },
          )
        }
        tile(`${name} · ${Math.round(point * 100)}%`)
      }
    }
  } else if (show === 'build') {
    // The build over bars 16 to 20 and the drop on bar 20, on Stars, which
    // shatters into Tunnel on the landing (or `?from=` into `?to=`). Picks
    // in bars from the start.
    const from = scene(params.get('from') ?? 'Stars')
    const to = scene(params.get('to') ?? 'Tunnel')
    const picks: Array<[number, string]> = [
      [15.5, 'before the build'],
      [17, 'build, bar 1'],
      [18.5, 'build, halfway'],
      [19.3, 'last bar'],
      [19.75, 'last beat'],
      [20 - 0.2 / 4, 'the inhale'],
      [20 + 1 / 60 / BAR, 'the landing frame'],
      [20 + 0.25 / 4, 'a quarter beat in'],
      [20 + 1 / 4, 'one beat in'],
      [20 + 2 / 4, 'two beats in'],
      [21, 'a bar in'],
      [22.5, 'the climax, strobing'],
    ]
    engine.clearScenes()
    const song = lab.song(BPM)
    let next = 0
    const landing = BAR * 20
    for (let t = BAR * 15; t < BAR * 23 && next < picks.length; t += dt) {
      const since = t - landing
      const changing = since >= 0 && since < 2 * BEAT
      const a = since < 0 ? from : changing ? from : to
      engine.frame(
        song(t),
        dt,
        a,
        to,
        changing ? Math.max(1e-4, since / (2 * BEAT)) : 0,
        screen,
        undefined,
        changing ? { kind: transitionCode('Shatter'), seed: 0.61 } : undefined,
      )
      const pick = picks[next]
      if (pick !== undefined && t >= pick[0] * BAR - 1e-6) {
        const bars = t / BAR - 20
        tile(
          `${pick[1]} · ${bars >= 0 ? '+' : ''}${(bars * 4).toFixed(2)} beats`,
        )
        next++
      }
    }
  } else if (show === 'glitch') {
    // A fill (the second half of bar 19), and the climax's bursts.
    const picks = [19.55, 19.62, 19.7, 19.86, 21.75, 21.8, 23.75, 23.8]
    for (const name of ['Halo', 'Terrain']) {
      engine.clearScenes()
      const song = lab.song(BPM)
      let next = 0
      const index = scene(name)
      for (let t = BAR * 18; next < picks.length; t += dt) {
        engine.frame(song(t), dt, index, index, 0, screen)
        const pick = picks[next]
        if (pick !== undefined && t >= pick * BAR) {
          tile(`${name} · bar ${(t / BAR).toFixed(2)}`)
          next++
        }
      }
    }
  } else if (show === 'bench') {
    benchChanges(lab, gl, params)
    return
  }
  console.log(`moments ${show} done`)
}

/**
 * What a change of scene costs, against the scene alone: each change from
 * Halo into each heavy scene, the whole frame, `FRAMES` frames between
 * two reads of a pixel, the median of `?runs=` (5). The dissolve it
 * replaced drew both scenes in turn, so it cost about one scene too, plus
 * reading both in `final`.
 */
const benchChanges = <M>(
  lab: MomentLab<M>,
  gl: WebGL2RenderingContext,
  params: URLSearchParams,
) => {
  const out = element('pre')
  document.body.append(out)
  const width = 1280
  const height = 720
  gl.canvas.width = width
  gl.canvas.height = height
  const engine = lab.makeEngine(gl, 1088, 612)
  engine.setCover(lab.cover())
  const runs = Math.max(1, Number(params.get('runs') ?? 5))
  const pixel = new Uint8Array(4)
  const finish = () =>
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)
  const FRAMES = 10
  const at = BAR * 21
  // oxlint-disable-next-line foldkit/no-impure-call-at-decision-time
  const clock = () => performance.now()
  const rows: Array<[string, number, number, SceneChange | undefined]> = []
  for (const into of ['Tunnel', 'Terrain']) {
    const to = lab.scenes.findIndex(name => name === into)
    const from = lab.scenes.findIndex(name => name === 'Halo')
    rows.push([`${into} alone`, to, to, undefined])
    for (const name of TRANSITIONS.slice(1))
      rows.push([
        `Halo → ${into} ${name}`,
        from,
        to,
        { kind: transitionCode(name), seed: 0.37 },
      ])
  }
  const times: Array<Array<number>> = rows.map(() => [])
  let run = 0
  const tick = () => {
    rows.forEach(([, a, b, change], index) => {
      const song = lab.song(BPM)
      for (let step = 0; step < 4; step++)
        engine.frame(song(at - step / 60), 1 / 60, a, a, 0, [width, height])
      finish()
      const started = clock()
      for (let step = 0; step < FRAMES; step++)
        engine.frame(
          song(at + step / 60),
          1 / 60,
          a,
          b,
          change === undefined ? 0 : 0.4,
          [width, height],
          undefined,
          change,
        )
      finish()
      times[index]?.push((clock() - started) / FRAMES)
    })
    run++
    const median = (values: ReadonlyArray<number> = []) =>
      [...values].sort((x, y) => x - y)[Math.floor(values.length / 2)] ?? 0
    const lines = rows.map(
      ([label], index) =>
        `${label.padEnd(28)} ${median(times[index]).toFixed(2).padStart(7)} ms`,
    )
    out.textContent = [`run ${run} of ${runs}`, ...lines].join('\n')
    if (run < runs) requestAnimationFrame(tick)
    else console.log(`bench changes\n${lines.join('\n')}`)
  }
  requestAnimationFrame(tick)
}
