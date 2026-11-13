import { describe, expect, test } from 'bun:test'
import { Option } from 'effect'

import { type Session, type Song } from '@music/shared'

import { type Model, initialModel } from './model.ts'
import {
  isByVideoArtist,
  isVideoArtwork,
  queuedVideos,
  withCleanTitles,
  withSongsForVideos,
} from './oldVideos.ts'

const FRAME = 'https://i.ytimg.com/vi/vid/hq720.jpg'
const COVER = 'https://lh3.googleusercontent.com/cover=w120-h120'

const track = (
  videoId: string,
  title: string,
  artworkUrl: string | null = FRAME,
): Session.QueueTrack => ({
  videoId,
  title,
  artists: 'Geese, Cameron Winter',
  album: null,
  durationSeconds: 250,
  artworkUrl,
})

const entry = (
  entryId: string,
  queued: Session.QueueTrack,
): Session.QueueEntry => ({ entryId, track: queued, autoplay: false })

const saved: Model = {
  ...initialModel,
  queue: [
    entry('e0', track('taxes-video', 'Geese - Taxes (Official Music Video)')),
    entry('e1', track('cobra-video', 'Cobra (Official Video)')),
    entry('e2', track('2122', '2122', COVER)),
    entry('e3', track('taxes-video', 'Geese - Taxes (Official Music Video)')),
  ],
  currentEntryId: 'e1',
}

const song = (videoId: string, title: string): Session.QueueTrack => ({
  videoId,
  title,
  artists: 'Geese',
  album: 'Getting Killed',
  durationSeconds: 200,
  artworkUrl: COVER,
})

describe('old music videos in the saved queue', () => {
  test('tells a video frame from a cover', () => {
    expect(isVideoArtwork(FRAME)).toBe(true)
    expect(isVideoArtwork(COVER)).toBe(false)
    expect(isVideoArtwork(null)).toBe(false)
  })

  test('cleans every title at once, as a video’s', () => {
    const titles = withCleanTitles(saved).queue.map(({ track }) => track.title)
    expect(titles).toEqual(['Taxes', 'Cobra', '2122', 'Taxes'])
    // A queue saved since is left as it is.
    const clean = withCleanTitles(saved)
    expect(withCleanTitles(clean).queue[2]).toBe(clean.queue[2])
  })

  test('looks up each video once, with its credits', () => {
    const videos = queuedVideos(withCleanTitles(saved))
    expect(videos.map(({ videoId }) => videoId)).toEqual([
      'taxes-video',
      'cobra-video',
    ])
    expect(videos[0]?.title).toBe('Taxes')
    expect(videos[0]?.artists.map(({ name }) => name)).toEqual([
      'Geese',
      'Cameron Winter',
    ])
  })

  test('takes only a song by one of the video’s artists', () => {
    const [video] = queuedVideos(saved)
    const by = (name: string): Song => ({
      videoId: 'taxes',
      title: 'Taxes',
      artists: [{ maybeId: Option.some('UC1'), name }],
      maybeAlbum: Option.none(),
      maybeDurationSeconds: Option.none(),
      artwork: [],
    })
    expect(video && isByVideoArtist(by('geese'), video)).toBe(true)
    expect(video && isByVideoArtist(by('Someone Else'), video)).toBe(false)
  })

  test('puts each song in its video’s place, the current entry keeping its recording', () => {
    const outcome = withSongsForVideos(
      saved,
      new Map([
        ['taxes-video', song('taxes', 'Taxes')],
        ['cobra-video', song('cobra', 'Cobra')],
      ]),
    )
    expect(outcome.broadcast).toBe(true)
    const [first, current, cover, again] = outcome.model.queue
    expect(first?.track).toEqual(song('taxes', 'Taxes'))
    expect(again?.track).toEqual(song('taxes', 'Taxes'))
    expect(cover).toBe(saved.queue[2])
    // The current entry shows the song, and plays on what is loaded.
    expect(current?.entryId).toBe('e1')
    expect(current?.track).toEqual({
      ...song('cobra', 'Cobra'),
      videoId: 'cobra-video',
      durationSeconds: 250,
    })
    // Nothing found: nothing changes, and no device hears of it.
    expect(withSongsForVideos(saved, new Map()).broadcast).toBe(false)
  })
})
