import { Context, Effect, Layer, Schema, Stream, SubscriptionRef } from 'effect'
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/http'

import { NowPlaying, type Session } from '@music/shared'

import { ArtworkPalette } from './palette/service.ts'
import { SessionHub } from './session/hub.ts'

/*
 * `GET /now-playing`: a read-only WebSocket for things outside the app, such
 * as the house lights. It follows the session and adds the cover's colors.
 * Listeners never join the session, so they never show up as a device.
 */

type Base = Omit<NowPlaying.NowPlaying, 'palette'>

const nothingPlaying: NowPlaying.NowPlaying = {
  _tag: 'NowPlaying',
  track: null,
  playing: false,
  device: null,
  palette: [],
}

export const toBase = (state: Session.SessionState): Base => {
  const entry = state.queue.find(
    ({ entryId }) => entryId === state.currentEntryId,
  )
  const device = state.devices.find(({ id }) => id === state.activeDeviceId)
  return {
    _tag: 'NowPlaying',
    track:
      entry === undefined
        ? null
        : {
            videoId: entry.track.videoId,
            title: entry.track.title,
            artists: entry.track.artists,
            album: entry.track.album,
            artworkUrl: entry.track.artworkUrl,
          },
    playing: entry !== undefined && state.playing,
    device:
      device === undefined ? null : { name: device.name, kind: device.kind },
  }
}

const encode = Schema.encodeSync(NowPlaying.NowPlayingJson)

const sameJson = <A extends NowPlaying.NowPlaying | Base>(x: A, y: A) =>
  JSON.stringify(x) === JSON.stringify(y)

export class NowPlayingFeed extends Context.Service<
  NowPlayingFeed,
  {
    /** The current value, then each change, already encoded as JSON. */
    readonly frames: Stream.Stream<string>
  }
>()('music/NowPlayingFeed') {}

export const NowPlayingFeedLive = Layer.effect(NowPlayingFeed)(
  Effect.gen(function* () {
    const hub = yield* SessionHub
    const palette = yield* ArtworkPalette
    const latest = yield* SubscriptionRef.make(nothingPlaying)

    yield* hub.states.pipe(
      Stream.map(toBase),
      Stream.changesWith(sameJson),
      Stream.switchMap(base =>
        Stream.fromEffect(
          base.track?.artworkUrl == null
            ? Effect.succeed([])
            : palette.forUrl(base.track.artworkUrl),
        ).pipe(Stream.map(swatches => ({ ...base, palette: swatches }))),
      ),
      Stream.changesWith(sameJson),
      Stream.runForEach(value => SubscriptionRef.set(latest, value)),
      Effect.forkScoped,
    )

    return NowPlayingFeed.of({
      frames: SubscriptionRef.changes(latest).pipe(
        Stream.changesWith(sameJson),
        Stream.map(value => encode(value)),
      ),
    })
  }),
)

export const NowPlayingRoutes = HttpRouter.use(router =>
  Effect.gen(function* () {
    const feed = yield* NowPlayingFeed
    yield* router.add(
      'GET',
      NowPlaying.NOW_PLAYING_PATH,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const socket = yield* Effect.orDie(request.upgrade)
        const writer = yield* socket.writer
        const reader = yield* socket.reader
        const send = feed.frames.pipe(
          Stream.runForEach(frame => writer.write(frame)),
        )
        // NOTE: listeners send nothing; reading only notices the close.
        const untilClosed = reader.pull.pipe(Effect.forever)
        yield* Effect.raceFirst(send, untilClosed).pipe(Effect.ignore)
        return HttpServerResponse.empty()
      }).pipe(Effect.scoped),
    )
  }),
)
