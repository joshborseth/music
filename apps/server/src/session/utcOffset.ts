import { Effect, Option } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'

/*
 * The house's UTC offset, for the TV's clock. It comes from the operating
 * system (`date +%z`), whose time zone rules are kept up to date. Bun's own
 * ICU and the TV's Android each carry an older copy that can miss a change:
 * from 2026-11-01 British Columbia stays on UTC-7 all year, and both of them
 * still turn the clock back to UTC-8.
 */

/** `-0700` → -420 minutes. */
export const parseUtcOffset = (text: string): Option.Option<number> => {
  const match = /^([+-])(\d{2})(\d{2})$/.exec(text.trim())
  if (match === null) return Option.none()
  const [, sign, hours, minutes] = match
  const total = Number(hours) * 60 + Number(minutes)
  return Option.some(sign === '-' ? -total : total)
}

/** What the JavaScript runtime thinks, when `date` cannot answer. */
const runtimeUtcOffset = (): number => -new Date().getTimezoneOffset()

export const readUtcOffsetMinutes: Effect.Effect<
  number,
  never,
  ChildProcessSpawner.ChildProcessSpawner
> = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const output = yield* spawner.string(ChildProcess.make('date', ['+%z']))
  return Option.getOrElse(parseUtcOffset(output), runtimeUtcOffset)
}).pipe(Effect.orElseSucceed(runtimeUtcOffset))
