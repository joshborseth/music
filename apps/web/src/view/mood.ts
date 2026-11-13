import { Array, Option, pipe } from 'effect'
import { AsyncData } from 'foldkit'
import { Html, HtmlBuilder } from 'foldkit/html'

import { type MoodDetails } from '@music/shared'

import { Message } from '../message'
import { SyncTitleBarReveal } from '../mount'
import { moodGroupsQuery, moodQuery } from '../query'
import { type PageModel } from './page'
import { moodGroupColors } from './search'
import {
  albumCard,
  loadingPage,
  playlistCard,
  remote,
  shelf,
  songGridShelf,
} from './shared'

const SONGS_ON_MOOD_PAGE = 20

/** The color of the category's tile, when the moods and genres list is loaded. */
const moodColor = (model: PageModel, params: string): Option.Option<string> =>
  pipe(
    AsyncData.getData(moodGroupsQuery.read(model.moodGroups)),
    Option.flatMap(groups =>
      Array.findFirst(groups, group =>
        pipe(
          Array.findFirstIndex(
            group.categories,
            category => category.params === params,
          ),
          Option.flatMap(index => Array.get(moodGroupColors(group), index)),
        ),
      ),
    ),
  )

const moodHeader = (
  details: MoodDetails,
  maybeColor: Option.Option<string>,
  h: HtmlBuilder<Message>,
): Html =>
  h.header(
    [
      h.Class(
        'flex flex-col gap-2 px-4 pt-[calc(var(--safe-top)+3.75rem)] pb-1',
      ),
    ],
    [
      h.span([
        h.AriaHidden(true),
        h.Class('h-1.5 w-10 rounded-full'),
        h.Style({
          backgroundColor: Option.getOrElse(maybeColor, () => 'var(--primary)'),
        }),
      ]),
      h.h1(
        [
          h.OnMount(SyncTitleBarReveal()),
          h.Class('text-[34px] leading-tight font-bold tracking-tight'),
        ],
        [details.title],
      ),
    ],
  )

/** A mood or genre: its songs, its playlists in shelves, and its albums. */
export const moodView = (
  model: PageModel,
  params: string,
  h: HtmlBuilder<Message>,
): Html =>
  remote(
    moodQuery.read(model.moods, { params }),
    {
      onLoading: () => loadingPage(h),
      onData: details =>
        h.div(
          [h.Class('flex flex-col gap-8 pb-6')],
          [
            moodHeader(details, moodColor(model, params), h),
            songGridShelf(
              {
                title: 'Songs',
                songs: Array.take(details.songs, SONGS_ON_MOOD_PAGE),
                playing: model.playing,
              },
              h,
            ),
            ...Array.map(details.playlistShelves, playlistShelf =>
              h.keyed('div')(
                playlistShelf.title,
                [h.Class('contents')],
                [
                  shelf(
                    {
                      title: playlistShelf.title,
                      items: playlistShelf.playlists,
                      toKey: playlist => playlist.id,
                      toCard: playlistCard,
                    },
                    h,
                  ),
                ],
              ),
            ),
            shelf(
              {
                title: 'Albums',
                items: details.albums,
                toKey: album => album.id,
                toCard: albumCard,
              },
              h,
            ),
          ],
        ),
    },
    h,
  )
