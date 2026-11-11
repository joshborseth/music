import {
  Config,
  Context,
  Effect,
  Layer,
  Option,
  Redacted,
  Schema,
} from 'effect'

/*
 * Wakes the TV and opens the Music app on it through Home Assistant, which
 * is already paired with the TV's built-in Android TV Remote service.
 * `remote.turn_on` with an `activity` turns the TV on and opens that deep
 * link; the TV app registers `music://`.
 */

export class WakeError extends Schema.TaggedError<WakeError>()('WakeError', {
  deviceId: Schema.String,
  message: Schema.String,
}) {}

export interface WakeableDevice {
  readonly id: string
  readonly name: string
}

export class TvWaker extends Context.Service<
  TvWaker,
  {
    /** Devices that can be woken, so they show up even while offline. */
    readonly devices: ReadonlyArray<WakeableDevice>
    readonly wake: (deviceId: string) => Effect.Effect<void, WakeError>
  }
>()('music/TvWaker') {}

const HomeAssistantConfig = Config.all({
  url: Config.String('HA_URL').pipe(
    Config.withDefault('http://127.0.0.1:8123'),
  ),
  token: Config.Redacted('HA_TOKEN'),
  entityId: Config.String('TV_HA_ENTITY'),
})

export const TvWakerLive = Layer.effect(TvWaker)(
  Effect.gen(function* () {
    const deviceId = yield* Config.String('TV_DEVICE_ID').pipe(
      Config.withDefault('tv'),
    )
    const name = yield* Config.String('TV_NAME').pipe(Config.withDefault('TV'))
    const launchUrl = yield* Config.String('TV_LAUNCH_URL').pipe(
      Config.withDefault('music://play'),
    )
    const maybeHomeAssistant = yield* Config.option(HomeAssistantConfig)

    return Option.match(maybeHomeAssistant, {
      onNone: () =>
        TvWaker.of({
          devices: [],
          wake: id =>
            Effect.fail(
              new WakeError({
                deviceId: id,
                message: 'Waking the TV is not set up on the server.',
              }),
            ),
        }),
      onSome: homeAssistant =>
        TvWaker.of({
          devices: [{ id: deviceId, name }],
          wake: id =>
            id !== deviceId
              ? Effect.fail(
                  new WakeError({ deviceId: id, message: 'Unknown device' }),
                )
              : Effect.tryPromise({
                  try: async signal => {
                    const response = await fetch(
                      `${homeAssistant.url}/api/services/remote/turn_on`,
                      {
                        method: 'POST',
                        signal,
                        headers: {
                          authorization: `Bearer ${Redacted.value(homeAssistant.token)}`,
                          'content-type': 'application/json',
                        },
                        body: JSON.stringify({
                          entity_id: homeAssistant.entityId,
                          activity: launchUrl,
                        }),
                      },
                    )
                    if (!response.ok) {
                      throw new Error(
                        `Home Assistant answered ${response.status}`,
                      )
                    }
                  },
                  catch: cause =>
                    new WakeError({
                      deviceId: id,
                      message:
                        cause instanceof Error ? cause.message : String(cause),
                    }),
                }).pipe(
                  Effect.timeout('15 seconds'),
                  Effect.mapError(error =>
                    error._tag === 'WakeError'
                      ? error
                      : new WakeError({
                          deviceId: id,
                          message: 'Home Assistant timed out',
                        }),
                  ),
                ),
        }),
    })
  }),
)
