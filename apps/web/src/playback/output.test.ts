import { Option } from 'effect'
import { describe, expect, test } from 'vitest'

import { type Session } from '@music/shared'

import {
  deviceStatus,
  deviceStatusText,
  outputText,
  playbackOutput,
} from './domain'

const phone: Session.Device = {
  id: 'phone',
  name: 'iPhone',
  kind: 'Web',
  online: true,
  waking: false,
  poweredOn: null,
  volume: null,
}

const tv: Session.Device = {
  id: 'tv',
  name: 'TV',
  kind: 'Tv',
  online: true,
  waking: false,
  poweredOn: true,
  volume: 0.5,
}

const session = (
  devices: ReadonlyArray<Session.Device>,
  activeDeviceId: string | null,
  playing: boolean,
): Session.SessionState => ({
  devices,
  activeDeviceId,
  queue: [],
  currentEntryId: 'e0',
  playing,
  positionSeconds: 0,
  positionAt: 0,
  seekSeq: 0,
  autoplay: true,
})

const me = Option.some('phone')

describe('where the music plays', () => {
  test('on the TV, playing or paused', () => {
    const playing = session([phone, tv], 'tv', true)
    expect(Option.map(playbackOutput(playing, me), outputText)).toEqual(
      Option.some('Playing on TV'),
    )
    const paused = session([phone, tv], 'tv', false)
    expect(Option.map(playbackOutput(paused, me), outputText)).toEqual(
      Option.some('Paused on TV'),
    )
  })

  test('on this phone', () => {
    expect(playbackOutput(session([phone, tv], 'phone', true), me)).toEqual(
      Option.none(),
    )
  })

  test('on a TV that is turning on', () => {
    const waking = session(
      [phone, { ...tv, online: false, waking: true }],
      'tv',
      true,
    )
    expect(Option.map(playbackOutput(waking, me), outputText)).toEqual(
      Option.some('Turning on TV…'),
    )
  })

  test('on a TV that dropped off while playing, until the server gives up', () => {
    const away = session([phone, { ...tv, online: false }], 'tv', true)
    expect(Option.map(playbackOutput(away, me), outputText)).toEqual(
      Option.some('Reconnecting to TV…'),
    )
  })

  test('here, once the paused player has gone away, as Play then plays here', () => {
    const away = session([phone, { ...tv, online: false }], 'tv', false)
    expect(playbackOutput(away, me)).toEqual(Option.none())
  })
})

describe('what a TV says in the device picker', () => {
  const statusOf = (device: Session.Device) =>
    deviceStatusText(
      device,
      deviceStatus(session([phone, device], 'phone', true), device),
    )

  test('off, on without the app, or open', () => {
    expect(statusOf({ ...tv, online: false, poweredOn: false })).toBe('Off')
    expect(statusOf({ ...tv, online: false, poweredOn: true })).toBe(
      "On · Music isn't open",
    )
    expect(statusOf({ ...tv, online: false, poweredOn: null })).toBe(
      "Music isn't open",
    )
    expect(statusOf(tv)).toBe('Music is open')
    expect(statusOf({ ...tv, online: false, waking: true })).toBe(
      'Turning on and opening Music…',
    )
  })
})
