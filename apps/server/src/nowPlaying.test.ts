import { describe, expect, test } from 'bun:test'
import { Schema } from 'effect'

import { NowPlaying, type Session } from '@music/shared'

import { toBase } from './nowPlaying.ts'

const track: Session.QueueTrack = {
  videoId: 'abc',
  title: 'Song',
  artists: 'Artist',
  album: 'Album',
  durationSeconds: 200,
  artworkUrl: 'https://lh3.googleusercontent.com/x=w120-h120',
}

const state: Session.SessionState = {
  devices: [
    {
      id: 'tv',
      name: 'TV',
      kind: 'Tv',
      online: true,
      waking: false,
      poweredOn: null,
      volume: null,
    },
    {
      id: 'phone',
      name: 'Phone',
      kind: 'Web',
      online: true,
      waking: false,
      poweredOn: null,
      volume: null,
    },
  ],
  activeDeviceId: 'tv',
  queue: [
    { entryId: 'e0', track: { ...track, videoId: 'first' }, autoplay: false },
    { entryId: 'e1', track, autoplay: false },
  ],
  currentEntryId: 'e1',
  playing: true,
  positionSeconds: 12,
  positionAt: 0,
  seekSeq: 0,
  autoplay: true,
  waitingToStart: false,
}

describe('toBase', () => {
  test('describes the current entry and the device playing it', () => {
    expect(toBase(state)).toEqual({
      _tag: 'NowPlaying',
      track: {
        videoId: 'abc',
        title: 'Song',
        artists: 'Artist',
        album: 'Album',
        artworkUrl: 'https://lh3.googleusercontent.com/x=w120-h120',
      },
      playing: true,
      device: { name: 'TV', kind: 'Tv' },
    })
  })

  test('is not playing once the queue has nothing current', () => {
    expect(
      toBase({ ...state, currentEntryId: null, activeDeviceId: null }),
    ).toEqual({ _tag: 'NowPlaying', track: null, playing: false, device: null })
  })

  test('encodes to the JSON that listeners decode', () => {
    const value: NowPlaying.NowPlaying = {
      ...toBase(state),
      color: '#1281b6',
      cue: { videoId: 'abc', color: null, at: 1_794_426_000_000 },
    }
    const json = Schema.encodeSync(NowPlaying.NowPlayingJson)(value)
    expect(Schema.decodeSync(NowPlaying.NowPlayingJson)(json)).toEqual(value)
  })

  test('rejects a color that is not #rrggbb', () => {
    expect(() => Schema.decodeSync(NowPlaying.Hex)('red')).toThrow()
  })
})
