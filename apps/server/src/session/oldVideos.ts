import { Option } from 'effect'

import { type ArtistLink, Session, type Song } from '@music/shared'

import { type MusicVideo, cleanVideoTitle } from '../youtubeMusic/mapping.ts'
import { type Model, type Outcome, refresh, unchanged } from './model.ts'

/*
 * A tidy of the queue saved before the app played songs, not music videos
 * (#73), and cleaned their titles (#75). At start the hub cleans every
 * title at once, then, without holding up the start, looks up the song each
 * music video is of and puts it in the video's place. Both leave a queue
 * saved since unchanged, so it runs at every start.
 */

/** A music video's thumbnail: a 16:9 frame of the video, not a cover. */
const VIDEO_THUMBNAIL = /^https:\/\/i\.ytimg\.com\/vi\//

export const isVideoArtwork = (url: string | null): boolean =>
  url !== null && VIDEO_THUMBNAIL.test(url)

/** The queue keeps the credits as one line: "Geese, Cameron Winter". */
const creditedArtists = (artists: string): ReadonlyArray<ArtistLink> =>
  artists.split(', ').map(name => ({ maybeId: Option.none(), name }))

/** The queue with every title cleaned as a music video's is. */
export const withCleanTitles = (model: Model): Model => ({
  ...model,
  queue: model.queue.map(entry => {
    const title = cleanVideoTitle(
      entry.track.title,
      creditedArtists(entry.track.artists),
    )
    return title === entry.track.title
      ? entry
      : { ...entry, track: { ...entry.track, title } }
  }),
})

/** The music videos in the queue, each once, as the song lookup takes them. */
export const queuedVideos = (model: Model): ReadonlyArray<MusicVideo> => [
  ...new Map(
    model.queue
      .filter(entry => isVideoArtwork(entry.track.artworkUrl))
      .map(({ track }): [string, MusicVideo] => [
        track.videoId,
        {
          videoId: track.videoId,
          title: track.title,
          artists: creditedArtists(track.artists),
        },
      ]),
  ).values(),
]

/**
 * Whether `song` is by one of the video's artists. The queue's credits link
 * nowhere, so the lookup matches on the title alone; this keeps it from
 * taking another artist's song of the same name.
 */
export const isByVideoArtist = (song: Song, video: MusicVideo): boolean =>
  song.artists.some(artist =>
    video.artists.some(
      other => other.name.toLowerCase() === artist.name.toLowerCase(),
    ),
  )

/**
 * The queue with each music video in `songs` (by the video's id) swapped for
 * its song. The current entry keeps its video id and length, and takes only
 * the song's title, credits, album, and cover.
 */
export const withSongsForVideos = (
  model: Model,
  songs: ReadonlyMap<string, Session.QueueTrack>,
): Outcome => {
  const queue = model.queue.map(entry => {
    const song = songs.get(entry.track.videoId)
    if (song === undefined || !isVideoArtwork(entry.track.artworkUrl)) {
      return entry
    }
    // NOTE: a player that has the current entry loaded follows it by its
    // entry id and `seekSeq`, so a new video id there would not reach it.
    // Its audio and the session would name different recordings.
    return entry.entryId === model.currentEntryId
      ? {
          ...entry,
          track: {
            ...song,
            videoId: entry.track.videoId,
            durationSeconds: entry.track.durationSeconds,
          },
        }
      : { ...entry, track: song }
  })
  return queue.some((entry, index) => entry !== model.queue[index])
    ? refresh({ ...model, queue })
    : unchanged(model)
}
