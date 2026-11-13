import { Array, Option, pipe } from 'effect'

/** Which text reads best on a background: light or dark. */
export type TextTone = 'Light' | 'Dark'

const HEX_COLOR = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i

/** One sRGB channel, 0 to 1, as linear light. */
const linear = (channel: number): number =>
  channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4

/** WCAG relative luminance of a `#rrggbb` color, 0 (black) to 1 (white). */
export const relativeLuminance = (hex: string): Option.Option<number> =>
  Option.map(Option.fromNullishOr(HEX_COLOR.exec(hex)), match => {
    const channel = (index: number): number =>
      linear(Number.parseInt(match[index] ?? '0', 16) / 255)
    return 0.2126 * channel(1) + 0.7152 * channel(2) + 0.0722 * channel(3)
  })

/**
 * Above this luminance a color takes dark text: white would fall below 3:1,
 * the least contrast for bold text. Strong mid-tones, such as a bright blue
 * or green, keep white text as on the colored tiles of music apps, though
 * black would measure a little higher on them.
 */
const DARK_TEXT_LUMINANCE = 0.3

/** Light or dark text for a `#rrggbb` background; see `DARK_TEXT_LUMINANCE`. */
export const textToneOn = (hex: string): Option.Option<TextTone> =>
  Option.map(relativeLuminance(hex), luminance =>
    luminance > DARK_TEXT_LUMINANCE ? 'Dark' : 'Light',
  )

// TILE COLORS

/**
 * The colors a mood or genre tile takes when YouTube Music's own is grey or
 * another tile's already: strong hues that keep their text readable, white
 * or near-black, as the browse tiles of Apple Music and Spotify do.
 */
export const TILE_PALETTE: ReadonlyArray<string> = [
  '#e8115b',
  '#1e3264',
  '#8d67ab',
  '#e13300',
  '#148a08',
  '#509bf5',
  '#dc148c',
  '#27856a',
  '#ba5d07',
  '#8400e7',
  '#0d73ec',
  '#e91429',
  '#006450',
  '#f59b23',
  '#af2896',
  '#477d95',
]

type Rgb = Readonly<{ red: number; green: number; blue: number }>

const rgbOf = (hex: string): Option.Option<Rgb> =>
  Option.map(Option.fromNullishOr(HEX_COLOR.exec(hex)), match => {
    const channel = (index: number): number =>
      Number.parseInt(match[index] ?? '0', 16)
    return { red: channel(1), green: channel(2), blue: channel(3) }
  })

/** Below this spread between its channels (out of 255), a color is grey. */
const GREY_CHROMA = 40

/** Whether a `#rrggbb` color is grey, as YouTube's Focus, Sad, and Metal are. */
export const isGrey = (hex: string): boolean =>
  Option.match(rgbOf(hex), {
    onNone: () => true,
    onSome: ({ red, green, blue }) =>
      Math.max(red, green, blue) - Math.min(red, green, blue) < GREY_CHROMA,
  })

/**
 * Closer than this "redmean" distance (black to white is about 765), two
 * tiles side by side look alike.
 */
const ALIKE_DISTANCE = 110

const looksAlike = (left: string, right: string): boolean =>
  Option.match(Option.all([rgbOf(left), rgbOf(right)]), {
    onNone: () => left.toLowerCase() === right.toLowerCase(),
    onSome: ([a, b]) => {
      const meanRed = (a.red + b.red) / 2
      const distance = Math.sqrt(
        (2 + meanRed / 256) * (a.red - b.red) ** 2 +
          4 * (a.green - b.green) ** 2 +
          (2 + (255 - meanRed) / 256) * (a.blue - b.blue) ** 2,
      )
      return distance < ALIKE_DISTANCE
    },
  })

/**
 * A color for each tile of a grid `columns` wide, in order. A tile keeps its
 * own color unless it is missing, grey, an earlier tile's, or like the tile
 * beside or above it; then it takes the first palette color no tile has yet
 * that differs from those two neighbours. So no tile is grey and no two
 * neighbours look the same.
 */
export const tileColors = (
  maybeColors: ReadonlyArray<Option.Option<string>>,
  columns: number,
): ReadonlyArray<string> =>
  Array.reduce(maybeColors, Array.empty<string>(), (colors, maybeColor) => {
    const index = colors.length
    const neighbours = Array.getSomes([
      index % columns === 0
        ? Option.none<string>()
        : Option.fromNullishOr(colors[index - 1]),
      Option.fromNullishOr(colors[index - columns]),
    ])
    const isFree = (color: string): boolean =>
      !Array.some(neighbours, neighbour => looksAlike(neighbour, color))
    const isUnused = (color: string): boolean =>
      !Array.some(colors, used => used.toLowerCase() === color.toLowerCase())
    const color = pipe(
      Option.filter(
        maybeColor,
        own =>
          Option.isSome(rgbOf(own)) &&
          !isGrey(own) &&
          isUnused(own) &&
          isFree(own),
      ),
      Option.orElse(() =>
        Array.findFirst(
          TILE_PALETTE,
          fallback => isUnused(fallback) && isFree(fallback),
        ),
      ),
      Option.orElse(() => Array.findFirst(TILE_PALETTE, isFree)),
      Option.getOrElse(
        () => TILE_PALETTE[index % TILE_PALETTE.length] ?? '#1e3264',
      ),
    )
    return Array.append(colors, color)
  })
