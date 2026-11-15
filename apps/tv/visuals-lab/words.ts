/*
 * The sung words in the lab, as the TV draws them (`src/visuals/words.rs`):
 * a word atlas (made here with canvas 2D in the app's type, through the
 * server's own distance field code, or a real one from the server's
 * `/tv/words`), the same choice of words and placing each frame, and the
 * `uWords` texture and `uWord*` uniforms for the engine.
 *
 * The words page (`dist/words.html`) draws every scene with a word in
 * flight, beside the lyrics and with the song alone, under a stand-in of
 * the app's screen, to look at. `labWords.load(json)` takes a real
 * `/tv/words` answer and draws it instead of the made-up song's.
 */

import { fieldBytes, signedDistance } from '../../server/src/words/sdf.ts'

declare const FONT: string

// THE WORDS --------------------------------------------------------------

interface Glyph {
  readonly text: string
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly baseline: number
}

interface Word {
  readonly startSeconds: number
  readonly endSeconds: number
  readonly text: string
  readonly line: number
  readonly glyph: number | null
  readonly hook: boolean
  readonly phrase: boolean
}

/** A song's words with their atlas decoded: the TV's `catalog::Words`. */
export interface WordsData {
  readonly words: ReadonlyArray<Word>
  readonly atlas: {
    readonly width: number
    readonly height: number
    readonly capHeight: number
    readonly spread: number
    readonly glyphs: ReadonlyArray<Glyph>
  }
  readonly pixels: Uint8Array
}

/** Where the words may go: `words::Room`. */
export type Room = 'Hidden' | 'Side' | 'Centre'

/** What the scenes get each frame: `words::Frame`. */
export interface WordsFrame {
  readonly rects: Float32Array
  readonly boxes: Float32Array
  readonly times: Float32Array
  readonly atlas: [number, number, number, number]
  /** The word Swarm spells: its slot (-1 none), how much (`words::spell`). */
  spell: [number, number, number, number]
}

const NOW = 0
const NEXT = 1
const BEFORE = 2
const LEAD = 0.04
const FADE_IN = 0.08
const LINGER = 0.6
const FADE_OUT = 0.5
const AHEAD = 1.5

const clamp01 = (x: number) => Math.min(1, Math.max(0, x))
const smoothstep = (from: number, to: number, x: number) => {
  const t = clamp01((x - from) / (to - from))
  return t * t * (3 - 2 * t)
}
// `words.rs`'s SPELL_HOLD, SPELL_KEEP, SPELL_GATHER.
const SPELL_HOLD = 0.4
const SPELL_KEEP = 0.5
const SPELL_GATHER = 0.45
const NO_SPELL: [number, number, number, number] = [-1, 0, 0, 0]

const hookLevel = (word: Word) => (word.phrase ? 1 : word.hook ? 0.6 : 0)

/** `words::word_box`. */
export const wordBox = (
  room: Room,
  word: Word,
  glyph: Glyph,
  cap: number,
  spread: number,
  aspect: number,
): [number, number, number, number] => {
  const level = hookLevel(word)
  const [middle, widest, plain, phrase]: [
    [number, number],
    number,
    number,
    number,
  ] =
    room === 'Centre'
      ? [[word.line % 2 === 0 ? 0.15 : 0.85, 0.47], 0.22, 0.11, 0.2]
      : [[0.675, 0.88], 0.56, 0.085, 0.13]
  const height = plain + (phrase - plain) * level
  let scale = height / Math.max(cap, 1)
  const ink = Math.max(glyph.width - 2 * spread, 1) * scale
  if (ink > widest * aspect) scale *= (widest * aspect) / ink
  const below = glyph.height / 2 - (glyph.baseline - cap / 2)
  return [
    (middle[0] - 0.5) * aspect,
    0.5 - middle[1] - below * scale,
    (glyph.width * scale) / 2,
    (glyph.height * scale) / 2,
  ]
}

/** `words::frame_at`. */
export const wordsFrame = (
  data: WordsData,
  seconds: number,
  room: Room,
  aspect: number,
  shown = 1,
): WordsFrame => {
  const frame: WordsFrame = {
    rects: new Float32Array(12),
    boxes: new Float32Array(12),
    times: new Float32Array(12),
    atlas: [data.atlas.width, data.atlas.height, data.atlas.spread, 0],
    spell: NO_SPELL,
  }
  if (room === 'Hidden') return frame
  const words = data.words
  const glyphOf = (index: number): Glyph | undefined => {
    const glyph = words[index]?.glyph
    return glyph === null || glyph === undefined
      ? undefined
      : data.atlas.glyphs[glyph]
  }
  let started = 0
  while (
    started < words.length &&
    (words[started]?.startSeconds ?? 0) - LEAD <= seconds
  )
    started++
  const find = (from: number, to: number, step: number): number => {
    for (let i = from; step > 0 ? i < to : i >= to; i += step)
      if (glyphOf(i) !== undefined) return i
    return -1
  }
  const now = find(started - 1, 0, -1)
  const next = find(started, words.length, 1)
  const before = now < 0 ? -1 : find(now - 1, 0, -1)
  const place = (
    slot: number,
    index: number,
    time: [number, number, number, number],
  ) => {
    const word = words[index]
    const glyph = glyphOf(index)
    if (word === undefined || glyph === undefined || time[3] <= 0) return
    const { width, height } = data.atlas
    frame.rects.set(
      [
        glyph.x / width,
        glyph.y / height,
        glyph.width / width,
        glyph.height / height,
      ],
      slot * 4,
    )
    frame.boxes.set(
      wordBox(
        room,
        word,
        glyph,
        data.atlas.capHeight,
        data.atlas.spread,
        aspect,
      ),
      slot * 4,
    )
    frame.times.set(time, slot * 4)
  }
  const current = words[now]
  if (current !== undefined) {
    const age = seconds - current.startSeconds
    const length = Math.max(current.endSeconds - current.startSeconds, 0.05)
    const coming = clamp01((age + LEAD) / FADE_IN)
    const gone = clamp01((seconds - current.endSeconds - LINGER) / FADE_OUT)
    place(NOW, now, [
      age,
      clamp01(age / length),
      hookLevel(current),
      shown * coming * (1 - gone),
    ])
    const previous = words[before]
    if (previous !== undefined) {
      const showed =
        current.startSeconds - previous.endSeconds < LINGER + FADE_OUT
      place(BEFORE, before, [age, 1, hookLevel(previous), showed ? shown : 0])
    }
  }
  const coming = words[next]
  if (coming !== undefined && seconds - coming.startSeconds > -AHEAD)
    place(NEXT, next, [
      seconds - coming.startSeconds,
      0,
      hookLevel(coming),
      shown,
    ])
  frame.atlas[3] = [0, 1, 2].some(slot => (frame.times[slot * 4 + 3] ?? 0) > 0)
    ? 1
    : 0
  // `words::spell`: which word Swarm spells, and how much.
  const spellable = (index: number): boolean => {
    const word = words[index]
    if (word === undefined || hookLevel(word) <= 0) return false
    const until =
      words[index + 1]?.startSeconds ?? word.endSeconds + LINGER
    return until - word.startSeconds >= SPELL_HOLD
  }
  const time = (slot: number, i: number) => frame.times[slot * 4 + i] ?? 0
  const at = (slot: number, share: number): [number, number, number, number] =>
    share > 0 ? [slot, Math.min(1, share), 0, 0] : NO_SPELL
  if (now >= 0 && spellable(now) && time(NOW, 3) > 0)
    frame.spell = at(NOW, time(NOW, 3))
  else if (
    before >= 0 &&
    spellable(before) &&
    time(BEFORE, 3) > 0 &&
    time(NOW, 0) < SPELL_KEEP
  )
    frame.spell = at(
      BEFORE,
      time(BEFORE, 3) *
        (1 - smoothstep(0.6 * SPELL_KEEP, SPELL_KEEP, time(NOW, 0))),
    )
  else if (next >= 0 && spellable(next) && time(NEXT, 3) > 0)
    frame.spell = at(NEXT, smoothstep(-SPELL_GATHER, -0.1, time(NEXT, 0)))
  return frame
}

// A MADE-UP SONG'S WORDS ---------------------------------------------------

/**
 * Words for the made-up song (`madeUpSong` in lab.ts) at `bpm`: a line a
 * bar from the verse on, a word a beat (a held one over two), the chorus
 * hook in the drop.
 */
export const madeUpLines = (
  bpm: number,
): ReadonlyArray<{ bar: number; text: string; hook: boolean }> => {
  const verse = [
    'I can feel the night',
    'running through my veins',
    'every light is gold',
    'nothing stays the same',
    'hold on to me now',
    'we are almost there',
    'can you hear it rise',
    'up into the air',
    'here it comes',
    'here it comes',
    'louder louder',
    'now',
  ]
  const chorus = [
    'light it up tonight',
    'burning like a star',
    'light it up tonight',
    'all the way we are',
  ]
  const lines = [
    ...verse.map((text, i) => ({ bar: 8 + i, text, hook: false })),
    ...[0, 1].flatMap(round =>
      chorus.map((text, i) => ({
        bar: 20 + round * 4 + i,
        text,
        hook: i % 2 === 0,
      })),
    ),
  ]
  void bpm
  return lines
}

const loadFont = async (): Promise<string> => {
  const bytes = Uint8Array.from(atob(FONT), c => c.charCodeAt(0))
  const face = new FontFace('Inter Display Lab', bytes)
  await face.load()
  document.fonts.add(face)
  return 'Inter Display Lab'
}

/**
 * An atlas of `texts` as the server draws one (`atlas.ts`): each word in
 * capitals twice the size kept, its distance field halved, packed in rows.
 */
export const madeUpAtlas = async (
  texts: ReadonlyArray<string>,
  cap = 64,
): Promise<WordsData['atlas'] & { pixels: Uint8Array }> => {
  const family = await loadFont()
  const scale = 2
  const spread = Math.round(cap * 0.25)
  const fontSize = Math.round((cap * scale) / 0.727)
  const pad = spread * scale + 4
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (context === null) throw new Error('no 2D canvas')
  const fields = texts.map(text => {
    context.font = `800 ${fontSize}px "${family}"`
    const metrics = context.measureText(text)
    const ascent = Math.ceil(metrics.actualBoundingBoxAscent)
    const descent = Math.ceil(metrics.actualBoundingBoxDescent)
    const width =
      Math.ceil(
        metrics.actualBoundingBoxLeft + metrics.actualBoundingBoxRight,
      ) +
      2 * pad
    const height = ascent + descent + 2 * pad
    canvas.width = width
    canvas.height = height
    context.fillStyle = '#000'
    context.fillRect(0, 0, width, height)
    context.fillStyle = '#fff'
    context.font = `800 ${fontSize}px "${family}"`
    context.fillText(text, pad + metrics.actualBoundingBoxLeft, pad + ascent)
    const rgba = context.getImageData(0, 0, width, height).data
    const coverage = new Uint8Array(width * height)
    for (let i = 0; i < coverage.length; i++) coverage[i] = rgba[i * 4] ?? 0
    const field = fieldBytes(
      signedDistance(coverage, width, height),
      width,
      height,
      scale,
      spread,
    )
    return { text, ...field, baseline: (pad + ascent) / scale }
  })
  context.font = `800 ${fontSize}px "${family}"`
  const capHeight = context.measureText('H').actualBoundingBoxAscent / scale
  // Shelves, the tallest first, as the server packs.
  const side = 2048
  const order = fields
    .map((_, i) => i)
    .sort((a, b) => (fields[b]?.height ?? 0) - (fields[a]?.height ?? 0))
  const places: Array<{ x: number; y: number }> = []
  let x = 0
  let y = 0
  let row = 0
  for (const i of order) {
    const field = fields[i]
    if (field === undefined) continue
    if (x + field.width + 1 > side) {
      x = 0
      y += row
      row = 0
    }
    places[i] = { x, y }
    x += field.width + 1
    row = Math.max(row, field.height + 1)
  }
  const height = y + row
  const pixels = new Uint8Array(side * height)
  const glyphs = fields.map((field, i) => {
    const place = places[i] ?? { x: 0, y: 0 }
    for (let r = 0; r < field.height; r++)
      pixels.set(
        field.bytes.subarray(r * field.width, (r + 1) * field.width),
        (place.y + r) * side + place.x,
      )
    return {
      text: field.text,
      ...place,
      width: field.width,
      height: field.height,
      baseline: field.baseline,
    }
  })
  return { width: side, height, capHeight, spread, glyphs, pixels }
}

/** The made-up song's words, timed a word a beat, with their atlas. */
export const madeUpWords = async (bpm: number): Promise<WordsData> => {
  const beat = 60 / bpm
  const words: Array<Omit<Word, 'glyph'>> = []
  madeUpLines(bpm).forEach(({ bar, text, hook }, line) => {
    const parts = text.split(' ')
    // A word a beat, or two a beat in a line of more than four.
    const step = parts.length > 4 ? beat / 2 : beat
    parts.forEach((part, i) => {
      const start = bar * 4 * beat + i * step
      words.push({
        startSeconds: start,
        endSeconds: start + (i === parts.length - 1 ? 2 * beat : step),
        text: part,
        line,
        hook,
        phrase: hook && i < 3 && text.startsWith('light it up'),
      })
    })
  })
  const texts = [...new Set(words.map(word => word.text.toUpperCase()))]
  const { pixels, ...atlas } = await madeUpAtlas(texts)
  return {
    words: words.map(word => ({
      ...word,
      glyph: texts.indexOf(word.text.toUpperCase()),
    })),
    atlas,
    pixels,
  }
}

/** A real `/tv/words` answer, its atlas PNG decoded. */
export const realWords = async (json: {
  readonly words: ReadonlyArray<Word>
  readonly atlas: (WordsData['atlas'] & { readonly png: string }) | null
}): Promise<WordsData> => {
  if (json.atlas === null) throw new Error('these words have no atlas')
  const image = new Image()
  image.src = `data:image/png;base64,${json.atlas.png}`
  await image.decode()
  const canvas = document.createElement('canvas')
  canvas.width = json.atlas.width
  canvas.height = json.atlas.height
  const context = canvas.getContext('2d')
  if (context === null) throw new Error('no 2D canvas')
  context.drawImage(image, 0, 0)
  const rgba = context.getImageData(0, 0, canvas.width, canvas.height).data
  const pixels = new Uint8Array(canvas.width * canvas.height)
  for (let i = 0; i < pixels.length; i++) pixels[i] = rgba[i * 4] ?? 0
  return { words: json.words, atlas: json.atlas, pixels }
}

// THE ENGINE'S PART -------------------------------------------------------

/** The unit `uWords` is bound to (gpu.rs, `WORDS_UNIT`). */
const WORDS_UNIT = 10

interface ProgramLike {
  readonly uniforms: Map<string, WebGLUniformLocation>
}

/** The words' texture and uniforms for one engine: gpu.rs's part. */
export const makeWordsGl = (gl: WebGL2RenderingContext) => {
  const texture = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.R8,
    1,
    1,
    0,
    gl.RED,
    gl.UNSIGNED_BYTE,
    new Uint8Array(1),
  )
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  let data: WordsData | null = null
  let room: Room = 'Side'
  let frame: WordsFrame | null = null

  return {
    /** Draw `words` from now on (none: no words). */
    load: (words: WordsData | null) => {
      data = words
      if (words === null) return
      gl.bindTexture(gl.TEXTURE_2D, texture)
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.R8,
        words.atlas.width,
        words.atlas.height,
        0,
        gl.RED,
        gl.UNSIGNED_BYTE,
        words.pixels,
      )
    },
    setRoom: (to: Room) => {
      room = to
    },
    /** The words at `seconds` into the song, once a frame. */
    update: (seconds: number, aspect: number) => {
      frame = data === null ? null : wordsFrame(data, seconds, room, aspect)
    },
    /** Whether a word shows this frame: the scenes draw with their words then. */
    showing: () => (frame?.atlas[3] ?? 0) > 0,
    /** Whether Swarm spells the word sung now (`words::spell`). */
    hook: () => (frame?.spell[1] ?? 0) > 0 && frame?.spell[0] === NOW,
    bind: (p: ProgramLike) => {
      const at = p.uniforms.get('uWords')
      if (at === undefined) return
      gl.activeTexture(gl.TEXTURE0 + WORDS_UNIT)
      gl.bindTexture(gl.TEXTURE_2D, texture)
      gl.uniform1i(at, WORDS_UNIT)
    },
    uniforms: (p: ProgramLike) => {
      const set = (name: string, values: Float32Array) => {
        const at = p.uniforms.get(name)
        if (at !== undefined) gl.uniform4fv(at, values)
      }
      set('uWordRect', frame?.rects ?? new Float32Array(12))
      set('uWordBox', frame?.boxes ?? new Float32Array(12))
      set('uWordTime', frame?.times ?? new Float32Array(12))
      const atlasAt = p.uniforms.get('uWordAtlas')
      if (atlasAt !== undefined)
        gl.uniform4f(atlasAt, ...(frame?.atlas ?? [1, 1, 1, 0]))
      const spellAt = p.uniforms.get('uWordSpell')
      if (spellAt !== undefined)
        gl.uniform4f(spellAt, ...(frame?.spell ?? NO_SPELL))
    },
  }
}

// THE WORDS PAGE ----------------------------------------------------------

/** What the words page needs from lab.ts. */
export interface WordsPageParts<Music extends { time: number }> {
  readonly scenes: ReadonlyArray<{ readonly name: string }>
  readonly makeEngine: (
    gl: WebGL2RenderingContext,
    width: number,
    height: number,
  ) => {
    readonly frame: (
      music: Music,
      dt: number,
      a: number,
      b: number,
      mix: number,
      screen: [number, number],
    ) => void
    readonly setCover: (cover: HTMLCanvasElement) => void
    readonly setSide: (on: boolean) => void
    readonly setWords: (words: WordsData | null) => void
    readonly clearScenes: () => void
  }
  readonly madeUpSong: (bpm: number) => (time: number) => Music
  readonly madeUpCover: () => HTMLCanvasElement
}

/** A stand-in of the app's screen over a tile: the song, and the lyrics or not. */
const drawScreen = (
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  side: boolean,
) => {
  const u = height / 54
  context.save()
  if (side) {
    context.fillStyle = 'rgba(40,40,48,0.9)'
    context.fillRect(u * 5.5, u * 7, u * 24, u * 24)
    context.fillStyle = '#fff'
    context.font = `700 ${u * 1.6}px system-ui, sans-serif`
    context.fillText('Song title', u * 5.5, u * 35)
    context.fillRect(u * 5.5, u * 41, u * 24, u * 0.3)
    const lines = [
      'The line before, sung',
      'The line being sung now',
      'The next line, and on',
      'And another line down',
      'A line further down',
      'The last line that fits',
    ]
    lines.forEach((line, i) => {
      context.fillStyle = i === 1 ? '#fff' : i < 1 ? '#8a8d94' : '#c4c6cc'
      context.font = `700 ${u * 2.1}px system-ui, sans-serif`
      context.fillText(line, u * 37, u * (10 + i * 6))
    })
  } else {
    context.fillStyle = 'rgba(40,40,48,0.9)'
    const art = u * 26
    context.fillRect((width - art) / 2, u * 7.5, art, art)
    context.fillStyle = '#fff'
    context.font = `700 ${u * 1.6}px system-ui, sans-serif`
    context.textAlign = 'center'
    context.fillText('Song title', width / 2, u * 37)
    context.fillRect(width / 2 - u * 20, u * 44, u * 40, u * 0.3)
  }
  context.restore()
}

/**
 * Every scene with a word in flight: rows of scenes, each at a few moments
 * of the made-up song (or real words), beside the lyrics and with the song
 * alone. `?at=` names the moments, in seconds; `?ui=0` leaves the screen's
 * stand-in off.
 */
export const wordsPage = <Music extends { time: number }>(
  parts: WordsPageParts<Music>,
) => {
  const params = new URLSearchParams(location.search)
  const width = Number(params.get('width') ?? 480)
  const height = Math.round((width * 9) / 16)
  const showUi = params.get('ui') !== '0'
  const root = document.createElement('div')
  root.style.cssText =
    'display:grid;gap:8px;padding:8px;grid-template-columns:repeat(4,1fr)'
  document.body.append(root)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true })
  if (gl === null) return
  const engine = parts.makeEngine(
    gl,
    Math.round(width * 0.85),
    Math.round(height * 0.85),
  )
  engine.setCover(parts.madeUpCover())
  const bpm = 124
  const beat = 60 / bpm
  let words: WordsData | null = null

  /** Render `scene` for a second up to `at`, `side` or not; a tile. */
  const tile = (scene: number, at: number, side: boolean, label: string) => {
    engine.clearScenes()
    engine.setSide(side)
    const song = parts.madeUpSong(bpm)
    const from = Math.max(0, at - 1.2)
    for (let t = from; t <= at + 1e-6; t += 1 / 30)
      engine.frame(song(t), 1 / 30, scene, scene, 0, [width, height])
    const out = document.createElement('canvas')
    out.width = width
    out.height = height
    const context = out.getContext('2d')
    if (context === null) return
    context.drawImage(canvas, 0, 0)
    if (showUi) drawScreen(context, width, height, side)
    const figure = document.createElement('figure')
    figure.style.margin = '0'
    const caption = document.createElement('figcaption')
    caption.style.cssText = 'color:#8c88a0;font:12px system-ui'
    caption.textContent = label
    figure.append(out, caption)
    root.append(figure)
  }

  const draw = (moments: ReadonlyArray<number>) => {
    root.replaceChildren()
    engine.setWords(words)
    const only = params.get('scene')
    parts.scenes.forEach((scene, index) => {
      if (only !== null && scene.name !== only) return
      for (const at of moments)
        tile(index, at, true, `${scene.name} · ${at.toFixed(2)}s · lyrics`)
      tile(
        index,
        moments[moments.length - 1] ?? 0,
        false,
        `${scene.name} · song alone`,
      )
    })
    console.log('words page done')
  }

  // A verse word just landing, mid-word, and the hook in the drop.
  const atParam = params.get('at')
  const moments =
    atParam === null
      ? [
          (8 * 4 + 1 + 0.12) * beat,
          (8 * 4 + 3 + 0.6) * beat,
          (20 * 4 + 1 + 0.35) * beat,
        ]
      : atParam.split(',').map(Number)
  void madeUpWords(bpm).then(made => {
    words = made
    draw(moments)
  })
  Object.assign(globalThis, {
    labWords: {
      /** Real words from `/tv/words`, drawn at `at` seconds (the made-up song's music). */
      load: async (
        json: Parameters<typeof realWords>[0],
        at: ReadonlyArray<number>,
      ) => {
        words = await realWords(json)
        draw(at)
      },
    },
  })
}
