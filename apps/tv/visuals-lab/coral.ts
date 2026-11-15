/*
 * The Coral scene, as the TV runs it (`apps/tv/src/visuals/coral.rs`):
 * Gray-Scott on a small grid in an integer texture (RG32UI), several steps
 * a frame, turned into a filtered picture the scene lights. `rhythm`
 * matches `coral.rs`'s `Rhythm`; keep the two in step.
 */

import {
  type LabProgram,
  type LabTarget,
  STATE2_UNIT,
  STATE_UNIT,
  type Sim,
  type SimMusic,
  type SimTools,
  type State,
  beginState,
  bindUnit,
  fullscreenVertex,
  makeState,
  setVec4,
  stateSource,
} from './particles'

type Vec4 = [number, number, number, number]

const GRID_HEIGHT = 144
const CALM_STEPS = 1.5
const WILD_STEPS = 4
const MOST_STEPS = 4
const KICK_RISE = 0.2
const DROP_RISE = 0.3
const FLASH = 0.75
const FLASH_FADE = 0.35
const REGROW = 1
const RATE = 2.5

/** The grid for a screen `aspect` times as wide as tall (`coral::grid`). */
export const grid = (aspect: number): [number, number] => [
  Math.round(GRID_HEIGHT * Math.min(2.5, Math.max(1, aspect))),
  GRID_HEIGHT,
]

const smoothstep = (from: number, to: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - from) / (to - from)))
  return t * t * (3 - 2 * t)
}

/** Feed and kill from spots (0) through coral (0.5) to a maze (1). */
export const feedKill = (pattern: number): [number, number] => {
  const spots: [number, number] = [0.0367, 0.0649]
  const coral: [number, number] = [0.052, 0.0635]
  const maze: [number, number] = [0.029, 0.057]
  const p = Math.min(1, Math.max(0, pattern))
  const [from, to, raw] =
    p < 0.5 ? [spots, coral, p * 2] : [coral, maze, p * 2 - 1]
  const t = raw * raw * (3 - 2 * raw)
  return [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t]
}

export interface CoralCues {
  readonly steps: number
  readonly feed: Vec4
  readonly blob: Vec4
  readonly line: Vec4
  readonly ink: Vec4
  readonly look: Vec4
}

/** `coral.rs`'s `Rhythm`: how the music grows the reef. */
export const rhythm = (seed: number, [wide, tall]: [number, number]) => {
  let lastTime: number | null = null
  let lastKick = 0
  let lastDrop = 0
  let bass = 0.5
  let energy = 0.4
  let kicks = 0
  let dropped: number | null = null
  let pen: [number, number] | null = null
  let owed = 0
  let fresh = true
  return (music: SimMusic): CoralCues => {
    const time = music.time
    const dt =
      lastTime === null ? 1 / 60 : Math.min(0.1, Math.max(0, time - lastTime))
    lastTime = time
    const parts = music.parts
    const ease = (value: number, toward: number, seconds: number) =>
      value + (toward - value) * (1 - Math.exp(-dt / seconds))
    bass = ease(bass, parts.bass, 1.5)
    energy = ease(energy, music.energy, 1)

    const sinceDrop = dropped === null ? Infinity : time - dropped
    const regrow = 1 + REGROW * Math.exp(-sinceDrop / 2)
    const rate =
      (CALM_STEPS + (WILD_STEPS - CALM_STEPS) * energy) *
      (1 - 0.85 * parts.stop) *
      regrow
    owed += rate * dt * 60
    const steps = Math.min(MOST_STEPS, Math.floor(owed))
    owed = Math.min(1, owed - steps)

    const [feed, kill] = feedKill(0.15 + 0.8 * bass)

    const rise = music.kick - lastKick
    lastKick = music.kick
    let blob: Vec4 = [0, 0, 0, 0]
    if (rise > KICK_RISE) {
      const n = kicks
      kicks++
      const angle = n * 2.399963 + seed * 2 * Math.PI
      const reach =
        (0.12 + 0.3 * (n * 0.618034 - Math.floor(n * 0.618034))) * tall
      blob = [
        wide * 0.5 + Math.cos(angle) * reach * 1.6,
        tall * 0.5 + Math.sin(angle) * reach,
        2.5 + 3 * rise,
        1,
      ]
    }

    const x = time * 0.035 + seed
    const nextPen: [number, number] = [
      (x - Math.floor(x)) * wide,
      (0.2 + 0.6 * parts.melody) * tall,
    ]
    const from =
      pen !== null && Math.abs(pen[0] - nextPen[0]) < wide * 0.5 ? pen : nextPen
    pen = nextPen
    const drawing = smoothstep(0.25, 0.6, parts.lead)

    let burst = 0
    if (music.drop - lastDrop > DROP_RISE) {
      dropped = time
      burst = 1
    }
    lastDrop = music.drop
    const since = dropped === null ? Infinity : time - dropped
    const white = FLASH * Math.exp(-since / FLASH_FADE)

    const reset = fresh ? 1 : 0
    fresh = false
    return {
      steps: Math.max(steps, reset, burst),
      feed: [feed, kill, RATE, 0],
      blob,
      line: [from[0], from[1], nextPen[0], nextPen[1]],
      ink: [drawing, 1.3, burst, reset],
      look: [
        0.5 + 1.6 * music.kick * (0.4 + 0.6 * music.energy) + 0.6 * music.drop,
        white,
        wide,
        tall,
      ],
    }
  }
}

/** Coral (`coral.rs`'s `Coral`). */
export const makeCoral = (tools: SimTools): Sim => {
  const { gl } = tools
  const [wide, tall] = grid(16 / 9)
  const step = tools.program(
    'coral_step.glsl',
    fullscreenVertex(tools),
    stateSource(tools, tools.shaderText('coral_step.glsl')),
  )
  const picture = tools.program(
    'coral_field.glsl',
    fullscreenVertex(tools),
    '#version 300 es\n' +
      tools.shaderText('common.glsl') +
      tools.shaderText('fragment.glsl') +
      tools.shaderText('helpers.glsl') +
      tools.shaderText('coral_field.glsl'),
  )
  const a = makeState(gl, wide, tall, 'rg')
  const b = makeState(gl, wide, tall, 'rg')
  const field: LabTarget = tools.makeTarget(wide, tall)
  const ready = step !== null && picture !== null && a !== null && b !== null
  let states: [State | null, State | null] = [a, b]
  let moves = rhythm(0, [wide, tall])
  let seed: number | null = null
  let look: Vec4 = [0, 0, 0, 0]
  return {
    ready,
    before: (music, newSeed, prepare) => {
      if (step === null || picture === null) return
      if (seed !== newSeed) {
        seed = newSeed
        moves = rhythm(newSeed, [wide, tall])
      }
      const cues = moves(music)
      look = cues.look
      gl.useProgram(step.program)
      prepare(step)
      setVec4(gl, step, 'uCoralFeed', cues.feed)
      for (let i = 0; i < cues.steps; i++) {
        const [now, next] = states
        if (now === null || next === null) return
        beginState(gl, next)
        bindUnit(gl, step, 'uState', STATE_UNIT, now.texture)
        if (i < 2) {
          const pick = (values: Vec4): Vec4 => (i === 0 ? values : [0, 0, 0, 0])
          setVec4(gl, step, 'uCoralBlob', pick(cues.blob))
          setVec4(gl, step, 'uCoralLine', pick(cues.line))
          setVec4(gl, step, 'uCoralInk', pick(cues.ink))
        }
        gl.drawArrays(gl.TRIANGLES, 0, 3)
        states = [next, now]
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, field.framebuffer)
      gl.viewport(0, 0, field.width, field.height)
      gl.invalidateFramebuffer(gl.FRAMEBUFFER, [gl.COLOR_ATTACHMENT0])
      gl.useProgram(picture.program)
      bindUnit(gl, picture, 'uState', STATE_UNIT, states[0]?.texture ?? null)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    },
    bind: (program: LabProgram) => {
      bindUnit(gl, program, 'uState2', STATE2_UNIT, field.texture)
      setVec4(gl, program, 'uCoralLook', look)
    },
    after: () => {},
    reset: () => {
      seed = null
    },
  }
}
