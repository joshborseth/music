import { Option } from 'effect'

import type { Model } from '../model'
import { type SessionSnapshot, loadedEntry, sessionPosition } from './domain'

/**
 * Where playback is, for showing it: the seek bar while it is dragged, the
 * phone's own audio clock when the phone plays, otherwise the session's.
 */
export const displayedPosition = (
  model: Model,
  snapshot: SessionSnapshot,
): number =>
  Option.getOrElse(model.maybeScrubSeconds, () => {
    const isPlayingHere = Option.exists(
      loadedEntry(model.phoneAudio),
      ({ entryId }) => entryId === snapshot.state.currentEntryId,
    )
    return isPlayingHere
      ? model.phoneAudioSeconds
      : sessionPosition(snapshot, model.now)
  })
