import { Option } from 'effect'

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
