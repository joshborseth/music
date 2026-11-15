/*
 * The particle engine and the Swarm scene, as the TV runs them
 * (`apps/tv/src/visuals/particles.rs`, `swarm.rs`): the particles' state in
 * integer textures (RGBA32UI, read with `texelFetch`), a formation pass
 * that writes each particle's target, an update pass, and one point a
 * particle added onto the scene. `choreography` matches `swarm.rs`'s
 * `Choreography`; keep the two in step.
 */

export interface LabProgram {
  readonly program: WebGLProgram
  readonly uniforms: Map<string, WebGLUniformLocation>
}

export interface LabTarget {
  readonly texture: WebGLTexture
  readonly framebuffer: WebGLFramebuffer
  readonly width: number
  readonly height: number
}

/** What the simulations read of the lab's music. */
export interface SimMusic {
  readonly time: number
  readonly beats: number
  readonly beatSeconds: number
  readonly kick: number
  readonly drop: number
  readonly energy: number
  readonly section: string
  readonly parts: {
    readonly snare: number
    readonly fill: number
    readonly lead: number
    readonly melody: number
    readonly bass: number
    readonly stop: number
  }
}

/** What a simulation needs from the lab's engine. */
export interface SimTools {
  readonly gl: WebGL2RenderingContext
  readonly program: (
    label: string,
    vertex: string,
    fragment: string,
  ) => LabProgram | null
  readonly shaderText: (name: string) => string
  readonly makeTarget: (width: number, height: number) => LabTarget
}

/** Sets the music's uniforms and the scene's inputs, as for the scene. */
export type Prepare = (program: LabProgram) => void

/** A scene that simulates before it draws (the TV's `sims.rs`). */
export interface Sim {
  readonly ready: boolean
  before: (music: SimMusic, seed: number, prepare: Prepare) => void
  bind: (program: LabProgram) => void
  after: (target: LabTarget, prepare: Prepare) => void
  /** Start over, as when the scene comes on again. */
  reset: () => void
}

export const STATE_UNIT = 11
export const STATE2_UNIT = 12
/** The particle texture: one particle a texel (`particles::SIDE`). */
export const SIDE: [number, number] = [256, 128]

const VERSION = '#version 300 es\n'

/** A fragment shader that writes integer state (`formation_source`). */
export const stateSource = (tools: SimTools, body: string): string =>
  VERSION +
  tools.shaderText('common.glsl') +
  tools.shaderText('particles.glsl') +
  tools.shaderText('helpers.glsl') +
  body

export const fullscreenVertex = (tools: SimTools): string =>
  VERSION + tools.shaderText('fullscreen.vert')

export interface State {
  readonly texture: WebGLTexture
  readonly framebuffer: WebGLFramebuffer
  readonly width: number
  readonly height: number
}

/** An integer texture to draw into (`State::new`), or null. */
export const makeState = (
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
  format: 'rgba' | 'rg',
): State | null => {
  const texture = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    format === 'rg' ? gl.RG32UI : gl.RGBA32UI,
    width,
    height,
    0,
    format === 'rg' ? gl.RG_INTEGER : gl.RGBA_INTEGER,
    gl.UNSIGNED_INT,
    null,
  )
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
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
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
    return null
  return { texture, framebuffer, width, height }
}

export const beginState = (gl: WebGL2RenderingContext, state: State) => {
  gl.bindFramebuffer(gl.FRAMEBUFFER, state.framebuffer)
  gl.viewport(0, 0, state.width, state.height)
  gl.invalidateFramebuffer(gl.FRAMEBUFFER, [gl.COLOR_ATTACHMENT0])
}

export const bindUnit = (
  gl: WebGL2RenderingContext,
  program: LabProgram,
  name: string,
  unit: number,
  texture: WebGLTexture | null,
) => {
  const at = program.uniforms.get(name)
  if (at === undefined) return
  gl.activeTexture(gl.TEXTURE0 + unit)
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.uniform1i(at, unit)
}

export const setVec4 = (
  gl: WebGL2RenderingContext,
  program: LabProgram,
  name: string,
  value: readonly [number, number, number, number],
) => {
  const at = program.uniforms.get(name)
  if (at !== undefined) gl.uniform4f(at, ...value)
}

export const setFloat = (
  gl: WebGL2RenderingContext,
  program: LabProgram,
  name: string,
  value: number,
) => {
  const at = program.uniforms.get(name)
  if (at !== undefined) gl.uniform1f(at, value)
}

const fullscreen = (gl: WebGL2RenderingContext) =>
  gl.drawArrays(gl.TRIANGLES, 0, 3)

// THE ENGINE ------------------------------------------------------------

type Vec4 = [number, number, number, number]

export interface Forces {
  readonly force: Vec4
  readonly blast: Vec4
  readonly stream: Vec4
}

/** The engine (`Particles`): its state, targets, and programs. */
export const makeParticles = (tools: SimTools, side: [number, number]) => {
  const { gl } = tools
  const update = tools.program(
    'particles_update.glsl',
    fullscreenVertex(tools),
    stateSource(tools, tools.shaderText('particles_update.glsl')),
  )
  const draw = tools.program(
    'particles.vert',
    VERSION +
      tools.shaderText('common.glsl') +
      tools.shaderText('particles.glsl') +
      tools.shaderText('helpers.glsl') +
      tools.shaderText('particles.vert'),
    VERSION +
      tools.shaderText('common.glsl') +
      tools.shaderText('particles.frag'),
  )
  const a = makeState(gl, side[0], side[1], 'rgba')
  const b = makeState(gl, side[0], side[1], 'rgba')
  const targets = makeState(gl, side[0], side[1], 'rgba')
  if (
    update === null ||
    draw === null ||
    a === null ||
    b === null ||
    targets === null
  )
    return null
  let states: [State, State] = [a, b]
  let reset = true
  const count = side[0] * side[1]

  const form = (formation: LabProgram, prepare: Prepare) => {
    beginState(gl, targets)
    gl.useProgram(formation.program)
    prepare(formation)
    bindUnit(gl, formation, 'uState', STATE_UNIT, states[0].texture)
    gl.activeTexture(gl.TEXTURE0 + STATE2_UNIT)
    gl.bindTexture(gl.TEXTURE_2D, null)
    fullscreen(gl)
  }

  const step = (forces: Forces, prepare: Prepare) => {
    const [now, next] = states
    beginState(gl, next)
    gl.useProgram(update.program)
    prepare(update)
    bindUnit(gl, update, 'uState', STATE_UNIT, now.texture)
    bindUnit(gl, update, 'uState2', STATE2_UNIT, targets.texture)
    setVec4(gl, update, 'uSwarmForce', forces.force)
    setVec4(gl, update, 'uSwarmBlast', forces.blast)
    setVec4(gl, update, 'uSwarmStream', forces.stream)
    setFloat(gl, update, 'uSwarmReset', reset ? 1 : 0)
    fullscreen(gl)
    states = [next, now]
    reset = false
  }

  const drawOnto = (
    target: LabTarget,
    size: number,
    gain: number,
    prepare: Prepare,
  ) => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer)
    gl.viewport(0, 0, target.width, target.height)
    gl.useProgram(draw.program)
    prepare(draw)
    bindUnit(gl, draw, 'uState', STATE_UNIT, states[0].texture)
    bindUnit(gl, draw, 'uState2', STATE2_UNIT, targets.texture)
    setFloat(gl, draw, 'uSwarmSize', size)
    setFloat(gl, draw, 'uSwarmGain', gain)
    gl.enable(gl.BLEND)
    gl.blendEquation(gl.FUNC_ADD)
    gl.blendFunc(gl.ONE, gl.ONE)
    gl.drawArrays(gl.POINTS, 0, count)
    gl.disable(gl.BLEND)
  }

  return {
    form,
    step,
    draw: drawOnto,
    reset: () => {
      reset = true
    },
  }
}

// THE SWARM'S MOVES -------------------------------------------------------

const COVER = 0
const SHAPES = 4
const PHRASE_BARS = 8
const MORPH_SECONDS = 1.6
const SNAP_SECONDS = 0.2
const NO_BEAT_SECONDS = 20
const NO_BEAT_BARS_SECONDS = 4
const KICK_RISE = 0.2
const DROP_RISE = 0.3
const APART_BEATS = 1.5
const APART_SECONDS = 1.2
const LONGEST_STEP = 1 / 20

export interface Cues {
  readonly form: Vec4
  readonly forces: Forces
  readonly trail: number
}

/** `swarm.rs`'s `Choreography`: the same moves from the same music. */
export const choreography = (seed: number) => {
  // As the TV works it out, in 32-bit floats.
  const scaled = Math.fround(
    Math.fround(Math.min(1, Math.max(0, seed))) * 16777215,
  )
  let random = (Math.imul(Math.floor(scaled), 2654435761) | 1) >>> 0
  const nextRandom = (): number => {
    random ^= random << 13
    random >>>= 0
    random ^= random >>> 17
    random ^= random << 5
    random >>>= 0
    return random
  }
  let from = COVER
  let to = COVER
  let changed = 0
  let morphSeconds = MORPH_SECONDS
  let bar: number | null = null
  let beat: number | null = null
  let barsOn = 0
  let barChanged = 0
  let section: string | null = null
  let sectionChanged = false
  let lastTime: number | null = null
  let lastKick = 0
  let lastDrop = 0
  let scattered: number | null = null
  let reformed = -Infinity
  let streamClock = seed * 40

  const change = (time: number, morph: number) => {
    const step = 1 + (nextRandom() % (SHAPES - 1))
    from = to
    to = (to + step) % SHAPES
    changed = time
    morphSeconds = morph
    barsOn = 0
  }

  return (music: SimMusic): Cues => {
    const time = music.time
    let dt: number
    if (lastTime === null) {
      changed = time
      barChanged = time
      dt = 1 / 60
    } else dt = Math.min(LONGEST_STEP, Math.max(0, time - lastTime))
    lastTime = time
    if (music.section !== section) {
      if (section !== null) sectionChanged = true
      section = music.section
    }
    const thisBar = Math.floor(music.beats / 4)
    const downbeat = bar !== null && thisBar > bar
    if (bar !== thisBar) {
      bar = thisBar
      barChanged = time
    }
    const thisBeat = Math.floor(music.beats)
    const newBeat = beat !== null && thisBeat > beat
    beat = thisBeat

    const dropped = music.drop - lastDrop > DROP_RISE
    lastDrop = music.drop
    let blast = 0
    let heat = 0
    if (dropped) {
      scattered = time
      blast += 2.2
      heat = 0.1
    }
    const beatless = time - barChanged > NO_BEAT_BARS_SECONDS
    if (scattered !== null) {
      const apart = time - scattered
      if (
        (newBeat && apart >= music.beatSeconds * APART_BEATS) ||
        (beatless && apart > APART_SECONDS)
      ) {
        scattered = null
        reformed = time
        sectionChanged = false
        change(time, SNAP_SECONDS)
      }
    } else if (downbeat) {
      barsOn++
      if (barsOn >= PHRASE_BARS || sectionChanged) {
        sectionChanged = false
        change(time, MORPH_SECONDS)
      }
    } else if (beatless && time - changed > NO_BEAT_SECONDS) {
      change(time, MORPH_SECONDS)
    }

    const rise = music.kick - lastKick
    lastKick = music.kick
    if (rise > KICK_RISE) {
      blast += rise * (0.35 + 0.55 * music.energy)
      heat = Math.max(heat, 0.35 * rise)
    }

    const scatter = scattered !== null ? 1 : 0
    const snap = Math.exp(-Math.max(0, time - reformed) * 2.5)
    const morph = Math.min(1, Math.max(0, (time - changed) / morphSeconds))
    const parts = music.parts
    const pull = scatter > 0 ? 30 : 20 * (1 + 5 * snap)
    const swirl = 0.05 + 0.5 * parts.snare + 0.25 * parts.fill + 0.3 * scatter
    const drag = scatter > 0 ? 1.8 : 4.2 + 8 * snap
    streamClock += dt * (0.5 + 0.7 * music.energy)
    const keep = 0.8 + 0.08 * scatter
    return {
      form: [from, to, morph, scattered === null ? 0 : 1 + (time - scattered)],
      forces: {
        force: [pull, swirl, drag, dt],
        blast: [0, 0, blast, heat],
        stream: [streamClock, (parts.melody - 0.5) * 0.35, parts.lead, 0.09],
      },
      trail: Math.pow(keep, dt * 60),
    }
  }
}

// THE SCENE -----------------------------------------------------------------

/** Swarm (`swarm.rs`'s `Swarm`). */
export const makeSwarm = (tools: SimTools): Sim => {
  const { gl } = tools
  const targets = tools.program(
    'swarm_targets.glsl',
    fullscreenVertex(tools),
    stateSource(tools, tools.shaderText('swarm_targets.glsl')),
  )
  const particles = makeParticles(tools, SIDE)
  let moves = choreography(0)
  let seed: number | null = null
  let trail = 0.8
  return {
    ready: targets !== null && particles !== null,
    before: (music, newSeed, prepare) => {
      if (targets === null || particles === null) return
      if (seed !== newSeed) {
        seed = newSeed
        moves = choreography(newSeed)
        particles.reset()
      }
      const cues = moves(music)
      trail = cues.trail
      particles.form(targets, program => {
        prepare(program)
        setVec4(gl, program, 'uSwarmForm', cues.form)
        setVec4(gl, program, 'uSwarmStream', cues.forces.stream)
      })
      particles.step(cues.forces, prepare)
    },
    bind: program => setFloat(gl, program, 'uSwarmTrail', trail),
    after: (target, prepare) => {
      particles?.draw(target, (2.6 * target.height) / 612, 0.55, prepare)
    },
    reset: () => {
      seed = null
    },
  }
}
