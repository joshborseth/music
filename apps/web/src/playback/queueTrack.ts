import { Option } from 'effect'

import { type Session, type Song } from '@music/shared'

import { artistNames, artworkUrl } from '../view/shared'

/** Artwork width handed to the TV and the lock screen. */
const QUEUE_ARTWORK_WIDTH = 360

export const toQueueTrack = (song: Song): Session.QueueTrack => ({
  videoId: song.videoId,
  title: song.title,
  artists: artistNames(song.artists),
  album: Option.getOrNull(Option.map(song.maybeAlbum, ({ name }) => name)),
  durationSeconds: Option.getOrNull(song.maybeDurationSeconds),
  artworkUrl: Option.getOrNull(artworkUrl(song.artwork, QUEUE_ARTWORK_WIDTH)),
})
