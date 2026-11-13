import { Array, Match, Option } from 'effect'
import { Html, HtmlBuilder, createKeyedLazy } from 'foldkit/html'

import type { LyricLine } from '@music/shared'

import {
  BREAK_DOTS,
  type LineState,
  type LyricRow,
  type SungWord,
  lyricRows,
} from '../lyrics'
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

/**
 * Each row is kept in its own slot, by its place in the lyrics, and drawn
 * again only when its state or its sung words change, so a tick redraws the
 * row being sung and nothing else.
 */
const lazyRow = createKeyedLazy()

/** Which of a line's words are sung, one character each. */
const sungWords = (words: ReadonlyArray<SungWord>): string =>
  Array.join(
    Array.map(words, ({ isSung }) => (isSung ? '1' : '0')),
    '',
  )

const sungRow = (
  line: LyricLine,
  state: LineState,
  sung: string,
  h: HtmlBuilder<Message>,
): Html =>
  h.keyed('div')(
    `line-${line.startSeconds}`,
    [
      h.DataAttribute('lyric-row', ''),
      h.DataAttribute('state', stateAttribute(state)),
      h.Class('lyric-row'),
    ],
    [
      h.button(
        [
          h.Type('button'),
          h.OnClick(Message.ClickedLyricLine({ seconds: line.startSeconds })),
          h.Class('lyric-line'),
        ],
        Array.match(line.words, {
          onEmpty: () => [line.text],
          onNonEmpty: words =>
            Array.map(words, (word, index) =>
              h.span(
                [
                  h.Class('lyric-word'),
                  h.DataAttribute(
                    'sung',
                    sung.charAt(index) === '1' ? 'true' : 'false',
                  ),
                ],
                [word.text],
              ),
            ),
        }),
      ),
    ],
  )

const breakRow = (
  startSeconds: number,
  isActive: boolean,
  litDots: number,
  h: HtmlBuilder<Message>,
): Html =>
  h.keyed('div')(
    `break-${startSeconds}`,
    [
      h.DataAttribute('lyric-row', ''),
      h.DataAttribute('state', isActive ? 'active' : 'idle'),
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
                h.DataAttribute('lit', index < litDots ? 'true' : 'false'),
              ]),
            ),
          ),
        ],
      ),
    ],
  )

const rowView = (
  row: LyricRow,
  index: number,
  h: HtmlBuilder<Message>,
): Html =>
  row._tag === 'Sung'
    ? lazyRow(index, sungRow, [row.line, row.state, sungWords(row.words), h])
    : lazyRow(index, breakRow, [row.startSeconds, row.isActive, row.litDots, h])

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
        Array.map(lyricRows(lines, positionSeconds), (row, index) =>
          rowView(row, index, h),
        ),
      ),
      Option.match(maybeSource, {
        onNone: () => h.empty,
        onSome: source =>
          h.p(
            [
              h.DataAttribute('lyrics-source', ''),
              h.Class('lyrics-source text-xs text-white/50'),
            ],
            [`Lyrics from ${source}`],
          ),
      }),
    ],
  )
