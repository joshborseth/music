import { describe, expect, test } from 'bun:test'
import { Option } from 'effect'

import {
  type PlanSource,
  type PrefetchJob,
  pageJobs,
  takeNextJob,
} from './prefetch.ts'

describe('prefetch planning', () => {
  test('page jobs download the first songs and resolve the next few', () => {
    expect(pageJobs(['a', 'b', 'c', 'd', 'e', 'f'], 2, 3)).toEqual([
      { videoId: 'a', kind: 'Download', priority: 1.5 },
      { videoId: 'b', kind: 'Download', priority: 2.5 },
      { videoId: 'c', kind: 'Resolve', priority: 12 },
      { videoId: 'd', kind: 'Resolve', priority: 13 },
      { videoId: 'e', kind: 'Resolve', priority: 14 },
    ])
  })

  test('takes the most urgent job across sources, skipping songs in progress', () => {
    const plans = new Map<PlanSource, Array<PrefetchJob>>([
      [
        'Queue:home',
        [
          { videoId: 'now', kind: 'Download', priority: 0 },
          { videoId: 'next', kind: 'Download', priority: 1 },
          { videoId: 'later', kind: 'Download', priority: 2 },
        ],
      ],
      ['Page:home', [{ videoId: 'page', kind: 'Download', priority: 1.5 }]],
    ])
    const order: Array<string> = []
    for (;;) {
      const maybeJob = takeNextJob(plans, new Set(['now']))
      if (Option.isNone(maybeJob)) break
      order.push(maybeJob.value.videoId)
    }
    expect(order).toEqual(['next', 'page', 'later'])
    expect(plans.get('Queue:home')).toEqual([
      { videoId: 'now', kind: 'Download', priority: 0 },
    ])
  })
})
