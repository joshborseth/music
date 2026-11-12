import { Option } from 'effect'

/*
 * What this app last did to the phone's audio element. Its events carry
 * these, so the player can ignore an event from a song it already left, and
 * tell its own play and pause from the system's: a call, Siri, unplugged
 * headphones, or another app's audio.
 */

const entryIds = new WeakMap<HTMLAudioElement, string>()
const songLengths = new WeakMap<HTMLAudioElement, number>()
const playIntents = new WeakMap<HTMLAudioElement, boolean>()

/**
 * Name the queue entry the element plays, or none (stopped, or the silent
 * unlock clip), with the song's length when YouTube Music gave one.
 */
export const markEntry = (
  audio: HTMLAudioElement,
  maybeEntryId: Option.Option<string>,
  maybeDurationSeconds: Option.Option<number> = Option.none(),
): void => {
  Option.match(maybeEntryId, {
    onNone: () => {
      entryIds.delete(audio)
    },
    onSome: entryId => {
      entryIds.set(audio, entryId)
    },
  })
  Option.match(
    Option.filter(
      maybeDurationSeconds,
      seconds => Number.isFinite(seconds) && seconds > 0,
    ),
    {
      onNone: () => {
        songLengths.delete(audio)
      },
      onSome: seconds => {
        songLengths.set(audio, seconds)
      },
    },
  )
}

export const entryIdOf = (audio: HTMLAudioElement): Option.Option<string> =>
  Option.fromNullishOr(entryIds.get(audio))

/**
 * How long the loaded song is, or NaN before anyone knows. Safari's own
 * `duration` can be twice the song: YouTube's audio is fragmented MP4 whose
 * header already holds the whole length, and Apple's player adds each
 * fragment's length on top as it reads them, which scrubbing makes it do.
 * So the shorter of Safari's figure and YouTube Music's wins.
 */
export const songDurationOf = (audio: HTMLAudioElement): number => {
  const known = songLengths.get(audio)
  const reported = audio.duration
  if (known === undefined) {
    return reported
  }
  return Number.isFinite(reported) && reported > 0
    ? Math.min(known, reported)
    : known
}

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

/**
 * What a song load should do once it has the song. A load first waits on
 * the phone's cache, so a pause, play, or seek that comes meanwhile changes
 * the load instead of the song it is replacing.
 */
export interface LoadPlan {
  readonly startSeconds: number
  readonly isPlaying: boolean
}

interface PendingLoad extends LoadPlan {
  readonly token: symbol
}

const pendingLoads = new WeakMap<HTMLAudioElement, PendingLoad>()

/** Start a load. A later load, or a stop, replaces it. */
export const beginLoad = (audio: HTMLAudioElement, plan: LoadPlan): symbol => {
  const token = Symbol('load')
  pendingLoads.set(audio, { ...plan, token })
  return token
}

/** The plan to carry out now, or none when the load was replaced. */
export const finishLoad = (
  audio: HTMLAudioElement,
  token: symbol,
): Option.Option<LoadPlan> => {
  const pending = pendingLoads.get(audio)
  if (pending === undefined || pending.token !== token) {
    return Option.none()
  }
  pendingLoads.delete(audio)
  return Option.some(pending)
}

export const cancelLoad = (audio: HTMLAudioElement): void => {
  pendingLoads.delete(audio)
}

export const isLoading = (audio: HTMLAudioElement): boolean =>
  pendingLoads.has(audio)

/** Change what the waiting load will do. False when no load is waiting. */
export const changeLoad = (
  audio: HTMLAudioElement,
  change: Partial<LoadPlan>,
): boolean => {
  const pending = pendingLoads.get(audio)
  if (pending === undefined) {
    return false
  }
  pendingLoads.set(audio, { ...pending, ...change })
  return true
}
