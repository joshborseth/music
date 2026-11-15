import { describe, expect, test } from 'bun:test'
import { Deferred, Effect, Option } from 'effect'

import { makeBackgroundQueue, makeFailureMemory } from './background.ts'

describe('the background queue', () => {
  test('a defect or a failure in one key does not stop the worker', async () => {
    const done: Array<string> = []
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const finished = yield* Deferred.make<void>()
          const queue = yield* makeBackgroundQueue({
            name: 'Test',
            capacity: 8,
            work: key =>
              key === 'dies'
                ? Effect.die(new Error('a bug'))
                : key === 'fails'
                  ? Effect.fail('no')
                  : Effect.sync(() => done.push(key)).pipe(
                      Effect.andThen(
                        key === 'last'
                          ? Deferred.succeed(finished, undefined)
                          : Effect.void,
                      ),
                    ),
          })
          yield* queue.offer('dies')
          yield* queue.offer('first')
          yield* queue.offer('fails')
          yield* queue.offer('last')
          yield* Deferred.await(finished)
        }),
      ),
    )
    expect(done).toEqual(['first', 'last'])
  })

  test('keeps each key once, and past capacity drops the one waiting longest', async () => {
    const done: Array<string> = []
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const gate = yield* Deferred.make<void>()
          const finished = yield* Deferred.make<void>()
          const queue = yield* makeBackgroundQueue({
            name: 'Test',
            capacity: 2,
            work: key =>
              Effect.gen(function* () {
                if (key === 'busy') yield* Deferred.await(gate)
                done.push(key)
                if (key === 'c') yield* Deferred.succeed(finished, undefined)
              }),
          })
          yield* queue.offer('busy')
          // The worker takes 'busy' and waits on the gate.
          yield* Effect.yieldNow
          yield* queue.offer('a')
          yield* queue.offer('b')
          yield* queue.offer('b')
          yield* queue.offer('c')
          expect(queue.size()).toBe(2)
          expect(queue.has('a')).toBe(false)
          yield* Deferred.succeed(gate, undefined)
          yield* Deferred.await(finished)
        }),
      ),
    )
    expect(done).toEqual(['busy', 'b', 'c'])
  })
})

describe('the failure memory', () => {
  test('forgets a failure once its wait is over', () => {
    let now = 0
    const memory = makeFailureMemory<string>({
      retryMs: error => (error === 'long' ? 100 : 10),
      now: () => now,
      capacity: 10,
    })
    memory.remember('a', 'short')
    memory.remember('b', 'long')
    now = 9
    expect(memory.recent('a')).toEqual(Option.some('short'))
    now = 10
    expect(memory.recent('a')).toEqual(Option.none())
    expect(memory.recent('b')).toEqual(Option.some('long'))
  })

  test('sweeps expired failures and keeps at most its capacity', () => {
    let now = 0
    const memory = makeFailureMemory<string>({
      retryMs: () => 10,
      now: () => now,
      capacity: 3,
    })
    memory.remember('old', 'x')
    now = 20
    memory.remember('a', 'x')
    // 'old' expired, and goes without being asked about.
    expect(memory.size()).toBe(1)
    memory.remember('b', 'x')
    memory.remember('c', 'x')
    memory.remember('d', 'x')
    expect(memory.size()).toBe(3)
    expect(memory.recent('a')).toEqual(Option.none())
    expect(memory.recent('d')).toEqual(Option.some('x'))
  })
})
