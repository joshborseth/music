import {
  Context,
  Effect,
  Layer,
  Option,
  Schema,
  Stream,
  SubscriptionRef,
} from 'effect'
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/http'

import { NowPlaying, type Session } from '@music/shared'

import { ArtworkPalette } from './palette/service.ts'
import { SessionHub } from './session/hub.ts'

/*
 * `GET /now-playing`: a WebSocket for things outside the app, such as the
 * house lights. It follows the session and adds the cover's color and the
 * hub's cues. Listeners only say what they follow (`Follow`); they never join
 * the session, so they never show up as a device.
 */

type Base = Omit<NowPlaying.NowPlaying, 'color' | 'cue'>

const nothingPlaying: NowPlaying.NowPlaying = {
  _tag: 'NowPlaying',
  track: null,
  playing: false,
  device: null,
  color: null,
  cue: null,
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

const decodeFollow = Schema.decodeUnknownOption(NowPlaying.FollowJson)
const textDecoder = new TextDecoder()

const sameJson = <A>(x: A, y: A) => JSON.stringify(x) === JSON.stringify(y)

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
    const artwork = yield* ArtworkPalette
    const latest = yield* SubscriptionRef.make(nothingPlaying)

    const withColors = hub.states.pipe(
      Stream.map(toBase),
      Stream.changesWith(sameJson),
      Stream.switchMap(base =>
        Stream.fromEffect(
          base.track?.artworkUrl == null
            ? Effect.succeed(null)
            : artwork.colorFor(base.track.artworkUrl),
        ).pipe(Stream.map(color => ({ ...base, color }))),
      ),
    )

    yield* Stream.zipLatest(withColors, hub.cues).pipe(
      Stream.map(([base, cue]): NowPlaying.NowPlaying => ({ ...base, cue })),
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
    const hub = yield* SessionHub
    yield* router.add(
      'GET',
      NowPlaying.NOW_PLAYING_PATH,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const socket = yield* Effect.orDie(request.upgrade)
        const writer = yield* socket.writer
        const reader = yield* socket.reader
        const follow = yield* hub.followLights
        const send = feed.frames.pipe(
          Stream.runForEach(frame => writer.write(frame)),
        )
        const receive = reader.pull.pipe(
          Effect.flatMap(frames =>
            Effect.forEach(
              frames,
              frame =>
                Option.match(
                  decodeFollow(
                    typeof frame === 'string'
                      ? frame
                      : textDecoder.decode(frame),
                  ),
                  {
                    onNone: () => Effect.void,
                    onSome: ({ kinds }) => follow(kinds),
                  },
                ),
              { discard: true },
            ),
          ),
          Effect.forever,
        )
        yield* Effect.raceFirst(send, receive).pipe(Effect.ignore)
        return HttpServerResponse.empty()
      }).pipe(Effect.scoped),
    )
  }),
)
