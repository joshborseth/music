import { Option } from 'effect'
import { type Html, type HtmlBuilder, createLazy } from 'foldkit/html'

import { type Message } from '../message'
import { type Model } from '../model'
import { Swipe } from '../playback/swipe'
import { type NowPlaying, nowPlaying } from './shared'

/**
 * What a page shows. Pages leave out the playback clock, so a playing song
 * re-renders only the player, never the page under it.
 */
export type PageModel = Readonly<
  Pick<
    Model,
    | 'route'
    | 'searchInput'
    | 'recentSearches'
    | 'recentlyPlayed'
    | 'recentlyViewed'
    | 'home'
    | 'songSearch'
    | 'artistSearch'
    | 'albumSearch'
    | 'playlistSearch'
    | 'songs'
    | 'artists'
    | 'albums'
    | 'playlists'
    | 'myLibrary'
    | 'myPlaylists'
    | 'swipe'
  > & { playing: NowPlaying }
>

/** One slot: only the page on screen is worth keeping. */
const lazyPage = createLazy()

const NO_ROW_SWIPE: Swipe = Swipe.Idle()

/**
 * The swipe the page shows: only one on a song row. Swiping the mini player
 * or the player leaves the page alone, so it is not redrawn on every move.
 */
const rowSwipe = (swipe: Swipe): Swipe =>
  swipe._tag === 'Tracking' && swipe.target._tag === 'SongRow'
    ? swipe
    : NO_ROW_SWIPE

type PageRenderer = (model: PageModel, h: HtmlBuilder<Message>) => Html

/**
 * Renders a page only when something it shows has changed. Every argument is
 * compared by reference, so the current song travels as its id.
 */
const renderPage = (
  render: PageRenderer,
  route: Model['route'],
  searchInput: string,
  recentSearches: Model['recentSearches'],
  recentlyPlayed: Model['recentlyPlayed'],
  recentlyViewed: Model['recentlyViewed'],
  home: Model['home'],
  songSearch: Model['songSearch'],
  artistSearch: Model['artistSearch'],
  albumSearch: Model['albumSearch'],
  playlistSearch: Model['playlistSearch'],
  songs: Model['songs'],
  artists: Model['artists'],
  albums: Model['albums'],
  playlists: Model['playlists'],
  myLibrary: Model['myLibrary'],
  myPlaylists: Model['myPlaylists'],
  swipe: Model['swipe'],
  currentVideoId: string,
  isPlaying: boolean,
  h: HtmlBuilder<Message>,
): Html =>
  render(
    {
      route,
      searchInput,
      recentSearches,
      recentlyPlayed,
      recentlyViewed,
      home,
      songSearch,
      artistSearch,
      albumSearch,
      playlistSearch,
      songs,
      artists,
      albums,
      playlists,
      myLibrary,
      myPlaylists,
      swipe,
      playing: {
        maybeVideoId: Option.liftPredicate(currentVideoId, id => id !== ''),
        isPlaying,
      },
    },
    h,
  )

export const memoizedPage = (
  model: Model,
  render: PageRenderer,
  h: HtmlBuilder<Message>,
): Html => {
  const playing = nowPlaying(model)
  return lazyPage(renderPage, [
    render,
    model.route,
    model.searchInput,
    model.recentSearches,
    model.recentlyPlayed,
    model.recentlyViewed,
    model.home,
    model.songSearch,
    model.artistSearch,
    model.albumSearch,
    model.playlistSearch,
    model.songs,
    model.artists,
    model.albums,
    model.playlists,
    model.myLibrary,
    model.myPlaylists,
    rowSwipe(model.swipe),
    Option.getOrElse(playing.maybeVideoId, () => ''),
    playing.isPlaying,
    h,
  ])
}
