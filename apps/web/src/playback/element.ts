import { Option } from 'effect'

/*
 * What this app last did to the phone's audio element. Its events carry
 * these, so the player can ignore an event from a song it already left, and
 * tell its own play and pause from the system's: a call, Siri, unplugged
 * headphones, or another app's audio.
 */

const entryIds = new WeakMap<HTMLAudioElement, string>()
const playIntents = new WeakMap<HTMLAudioElement, boolean>()

/** Name the queue entry the element plays, or none (stopped, or the silent unlock clip). */
export const markEntry = (
  audio: HTMLAudioElement,
  maybeEntryId: Option.Option<string>,
): void =>
  Option.match(maybeEntryId, {
    onNone: () => {
      entryIds.delete(audio)
    },
    onSome: entryId => {
      entryIds.set(audio, entryId)
    },
  })

export const entryIdOf = (audio: HTMLAudioElement): Option.Option<string> =>
  Option.fromNullishOr(entryIds.get(audio))

/** Whether this app last asked the element to play. */
export const isMeantToPlay = (audio: HTMLAudioElement): boolean =>
  playIntents.get(audio) ?? false

/**
 * Take what the element now does as what the app means: after a play or
 * pause the app did not ask for is reported, or a start the browser refused.
 */
export const followIntent = (
  audio: HTMLAudioElement,
  isPlaying: boolean,
): void => {
  playIntents.set(audio, isPlaying)
}

export const startAudio = (audio: HTMLAudioElement): Promise<void> => {
  playIntents.set(audio, true)
  return audio.play()
}

export const pauseAudio = (audio: HTMLAudioElement): void => {
  playIntents.set(audio, false)
  audio.pause()
}
