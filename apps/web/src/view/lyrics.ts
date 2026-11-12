import { Array, Match, Option } from 'effect'
import { Html, HtmlBuilder } from 'foldkit/html'

import type { LyricLine } from '@music/shared'

import { BREAK_DOTS, type LineState, type LyricRow, lyricRows } from '../lyrics'
import { Message } from '../message'
import { FollowLyrics } from '../mount'

/*
 * Timed lyrics in the full player. The line being sung springs up to full
 * size and brightness, sung words light up one by one, and a rest between
 * lines shows three dots that breathe and light up as it runs out.
 * `FollowLyrics` glides the lines up as the song moves on. The motion lives
 * in `styles.css` under LYRICS.
 */

const stateAttribute = (state: LineState): string =>
  Match.value(state).pipe(
    Match.when('Past', () => 'past'),
    Match.when('Active', () => 'active'),
    Match.when('Next', () => 'next'),
    Match.exhaustive,
  )

const sungRow = (
  row: Extract<LyricRow, { _tag: 'Sung' }>,
  h: HtmlBuilder<Message>,
): Html =>
  h.keyed('div')(
    `line-${row.startSeconds}`,
    [
      h.DataAttribute('lyric-row', ''),
      h.DataAttribute('state', stateAttribute(row.state)),
      h.Class('lyric-row'),
    ],
    [
      h.button(
        [
          h.Type('button'),
          h.OnClick(Message.ClickedLyricLine({ seconds: row.startSeconds })),
          h.Class('lyric-line'),
        ],
        Array.match(row.words, {
          onEmpty: () => [row.text],
          onNonEmpty: words =>
            Array.map(words, word =>
              h.span(
                [
                  h.Class('lyric-word'),
                  h.DataAttribute('sung', word.isSung ? 'true' : 'false'),
                ],
                [word.text],
              ),
            ),
        }),
      ),
    ],
  )

const breakRow = (
  row: Extract<LyricRow, { _tag: 'Break' }>,
  h: HtmlBuilder<Message>,
): Html =>
  h.keyed('div')(
    `break-${row.startSeconds}`,
    [
      h.DataAttribute('lyric-row', ''),
      h.DataAttribute('state', row.isActive ? 'active' : 'idle'),
      h.AriaHidden(true),
      h.Class('lyric-break'),
    ],
    [
      h.div(
        [h.Class('lyric-break-inner')],
        [
          h.div(
            [h.Class('lyric-dots')],
            Array.makeBy(BREAK_DOTS, index =>
              h.span([
                h.Class('lyric-dot'),
                h.DataAttribute('lit', index < row.litDots ? 'true' : 'false'),
              ]),
            ),
          ),
        ],
      ),
    ],
  )

/** The lyrics panel's contents when the lyrics are timed. */
export const timedLyrics = (
  lines: ReadonlyArray<LyricLine>,
  positionSeconds: number,
  isPlaying: boolean,
  maybeSource: Option.Option<string>,
  scrollClass: string,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [
      h.DataAttribute('sheet-scroll', ''),
      h.DataAttribute('playing', isPlaying ? 'true' : 'false'),
      h.OnMount(FollowLyrics()),
      h.Class(`lyrics ${scrollClass}`),
    ],
    [
      h.div(
        [h.Class('lyrics-lines')],
        Array.map(lyricRows(lines, positionSeconds), row =>
          row._tag === 'Sung' ? sungRow(row, h) : breakRow(row, h),
        ),
      ),
      Option.match(maybeSource, {
        onNone: () => h.empty,
        onSome: source =>
          h.p(
            [h.Class('lyrics-source text-xs text-white/50')],
            [`Lyrics from ${source}`],
          ),
      }),
    ],
  )
