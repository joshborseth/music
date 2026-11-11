/*
 * A song on its way from YouTube. Its bytes land in one buffer as they
 * arrive, and any number of players read from it at the same time, each
 * from its own byte range. A player whose range is not there yet waits for
 * it, so a song starts playing on its first bytes instead of after the
 * whole download.
 */

type Status = 'Running' | 'Done' | 'Failed'

export class SongDownload {
  readonly buffer: Uint8Array
  #received = 0
  #status: Status = 'Running'
  #waiters: Array<() => void> = []
  readonly #finished: Promise<boolean>
  #settle: (isComplete: boolean) => void = () => {}

  constructor(readonly size: number) {
    this.buffer = new Uint8Array(size)
    this.#finished = new Promise(resolve => {
      this.#settle = resolve
    })
  }

  get received(): number {
    return this.#received
  }

  /** Resolves `true` once every byte is here, or `false` if it failed. */
  get finished(): Promise<boolean> {
    return this.#finished
  }

  append(chunk: Uint8Array): void {
    if (this.#status !== 'Running') return
    const room = this.size - this.#received
    const piece = chunk.byteLength > room ? chunk.subarray(0, room) : chunk
    this.buffer.set(piece, this.#received)
    this.#received += piece.byteLength
    this.#wake()
  }

  finish(): void {
    if (this.#status !== 'Running') return
    this.#status = this.#received === this.size ? 'Done' : 'Failed'
    this.#settle(this.#status === 'Done')
    this.#wake()
  }

  fail(): void {
    if (this.#status !== 'Running') return
    this.#status = 'Failed'
    this.#settle(false)
    this.#wake()
  }

  /** Bytes `start` through `end` (inclusive), each piece as soon as it arrives. */
  async *read(start: number, end: number): AsyncGenerator<Uint8Array> {
    let position = start
    while (position <= end) {
      if (position < this.#received) {
        const until = Math.min(this.#received, end + 1)
        // The buffer never changes behind `received`, so a view is safe.
        yield this.buffer.subarray(position, until)
        position = until
      } else if (this.#status === 'Running') {
        await new Promise<void>(resolve => this.#waiters.push(resolve))
      } else {
        throw new Error('The download stopped before this part arrived')
      }
    }
  }

  #wake(): void {
    const waiters = this.#waiters
    this.#waiters = []
    for (const wake of waiters) wake()
  }
}

/** How many bytes a ranged YouTube response will carry. */
export const responseLength = (headers: Headers): number | undefined => {
  const length = Number(headers.get('content-length'))
  if (Number.isInteger(length) && length > 0) return length
  const match = /^bytes (\d+)-(\d+)\//.exec(headers.get('content-range') ?? '')
  return match === null ? undefined : Number(match[2]) - Number(match[1]) + 1
}

/** Copy a response body into the download, then mark it finished or failed. */
export const pump = async (
  body: ReadableStream<Uint8Array>,
  download: SongDownload,
): Promise<void> => {
  const reader = body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      download.append(value)
    }
    download.finish()
  } catch {
    download.fail()
  }
}
