import { afterAll, describe, expect, test } from 'bun:test'
import { HttpRouter } from 'effect/http'

import { Session } from '@music/shared'

import { ResyncReportRoute } from './hub.ts'

describe('POST /session/resync', () => {
  const { handler, dispose } = HttpRouter.toWebHandler(ResyncReportRoute, {
    disableLogger: true,
  })
  afterAll(() => dispose())
  const post = (body: string) =>
    handler(
      new Request(`http://phone${Session.RESYNC_REPORT_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      }),
    )

  test('takes a phone’s report', async () => {
    const report: Session.ResyncReport = {
      hiddenForMs: 60_000,
      socketMs: 400,
      stateMs: 550,
      host: '192.168.1.67:4311',
    }
    expect((await post(JSON.stringify(report))).status).toBe(204)
  })

  test('turns down anything else', async () => {
    expect((await post('{"stateMs":"soon"}')).status).toBe(400)
    expect((await post('not json')).status).toBe(400)
  })
})
