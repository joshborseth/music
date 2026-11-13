import {
  Array,
  Cache,
  Config,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  String,
  pipe,
} from 'effect'
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
  HttpStaticServer,
} from 'effect/http'
import { promisify } from 'node:util'
import { brotliCompress, constants, gzip } from 'node:zlib'

/*
 * Serves the built web app from `WEB_DIST_DIR`, so one origin carries both
 * the app and its RPC endpoint. In development Vite serves the app.
 *
 * Vite names every file under `/assets/` after a hash of its contents, so a
 * browser may keep those forever. Everything else (index.html, the service
 * worker, the manifest, the icons) keeps its name across builds, so the
 * browser asks again each time and gets a 304 when nothing changed.
 *
 * Text files go out compressed, Brotli when the browser takes it, else
 * gzip. Each file is compressed once, as the server starts (or on its first
 * request, if that comes sooner), and kept in memory until it changes on
 * disk; the whole app is well under a megabyte.
 */

/** For the hashed files under `/assets/`, which never change. */
export const IMMUTABLE = 'public, max-age=31536000, immutable'
/** For the files that keep their names: check with the server each time. */
export const REVALIDATE = 'no-cache'

const HASHED_PREFIX = '/assets/'

export const cacheControlFor = (pathname: string): string =>
  pathname.startsWith(HASHED_PREFIX) ? IMMUTABLE : REVALIDATE

const INDEX = 'index.html'

const STATIC_MIME_TYPES = { webmanifest: 'application/manifest+json' }

/** The text files worth compressing, and the type each is served as. */
const COMPRESSIBLE_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
}

export type Encoding = 'br' | 'gzip'

const ENCODING_PREFERENCE: ReadonlyArray<Encoding> = ['br', 'gzip']

/**
 * The best encoding an `Accept-Encoding` header takes: Brotli, then gzip.
 * One listed with `q=0` is refused.
 */
export const preferredEncoding = (
  maybeAcceptEncoding: string | undefined,
): Option.Option<Encoding> => {
  const accepted = pipe(
    (maybeAcceptEncoding ?? '').split(','),
    Array.map(part => {
      const [name = '', ...params] = part.split(';').map(String.trim)
      const isRefused = Array.some(params, param =>
        /^q=0(?:\.0{0,3})?$/i.test(param),
      )
      return { name: name.toLowerCase(), isRefused }
    }),
    Array.filter(({ isRefused }) => !isRefused),
    Array.map(({ name }) => name),
  )
  return Array.findFirst(ENCODING_PREFERENCE, encoding =>
    Array.contains(accepted, encoding),
  )
}

const brotli = promisify(brotliCompress)
const gzipAsync = promisify(gzip)

const compress = (body: Uint8Array, encoding: Encoding) =>
  Effect.promise(() =>
    encoding === 'br'
      ? brotli(body, {
          params: {
            [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
            [constants.BROTLI_PARAM_SIZE_HINT]: body.byteLength,
          },
        })
      : gzipAsync(body, { level: constants.Z_BEST_COMPRESSION }),
  ).pipe(Effect.map(buffer => new Uint8Array(buffer)))

/** A file to send compressed, as it is on disk now. */
type TextFile = Readonly<{
  filePath: string
  contentType: string
  size: bigint
  modifiedMs: number
}>

const acceptsHtml = (maybeAccept: string | undefined): boolean =>
  (maybeAccept ?? '').toLowerCase().includes('text/html')

const COMPRESSED_CAPACITY = 128
const KEY_SEPARATOR = '\u0000'

/**
 * The route for every path the other routes leave: the web app's files,
 * and index.html for the app's own pages (`/search`, `/album/…`).
 */
export const webAppRoute = (root: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const resolvedRoot = path.resolve(root)
    const options = {
      root: resolvedRoot,
      spa: true,
      mimeTypes: STATIC_MIME_TYPES,
    }
    const immutableFiles = yield* HttpStaticServer.make({
      ...options,
      cacheControl: IMMUTABLE,
    })
    const revalidatedFiles = yield* HttpStaticServer.make({
      ...options,
      cacheControl: REVALIDATE,
    })

    /**
     * Keyed by the file's path, the encoding, and the file's size and time,
     * so a file changed on disk is compressed again.
     */
    const compressed = yield* Cache.makeWith(
      (key: string) => {
        const [filePath = '', encoding] = key.split(KEY_SEPARATOR)
        return fs
          .readFile(filePath)
          .pipe(
            Effect.flatMap(body =>
              compress(body, encoding === 'br' ? 'br' : 'gzip'),
            ),
          )
      },
      {
        capacity: COMPRESSED_CAPACITY,
        timeToLive: Exit.match({
          onFailure: () => Duration.zero,
          onSuccess: () => Duration.infinity,
        }),
      },
    )

    const textFileAt = (filePath: string) =>
      fs.stat(filePath).pipe(
        Effect.map(info =>
          Option.all({
            file: Option.liftPredicate(info, ({ type }) => type === 'File'),
            contentType: Option.fromNullishOr(
              COMPRESSIBLE_TYPES[path.extname(filePath).toLowerCase()],
            ),
          }),
        ),
        Effect.map(
          Option.map(({ file, contentType }): TextFile => ({
            filePath,
            contentType,
            size: file.size,
            modifiedMs: Option.match(file.mtime, {
              onNone: () => 0,
              onSome: date => date.getTime(),
            }),
          })),
        ),
        Effect.orElseSucceed(() => Option.none<TextFile>()),
      )

    /**
     * The text file a request asks for, as the static server would pick it:
     * the file itself, a folder's index.html, or index.html for a page of
     * the app. None for anything else, which the static server answers.
     */
    const requestedTextFile = (
      request: HttpServerRequest.HttpServerRequest,
      pathname: string,
    ) =>
      Effect.gen(function* () {
        const maybeDecoded = Option.liftThrowable(decodeURIComponent)(pathname)
        const maybeFilePath = pipe(
          maybeDecoded,
          Option.filter(decoded => !decoded.includes('\u0000')),
          Option.flatMap(decoded =>
            path.resolveWithin(resolvedRoot, decoded.replace(/^\/+/, '')),
          ),
        )
        if (Option.isNone(maybeFilePath)) {
          return Option.none<TextFile>()
        }
        const filePath = maybeFilePath.value
        const info = yield* Effect.option(fs.stat(filePath))
        const isDirectory = Option.exists(
          info,
          ({ type }) => type === 'Directory',
        )
        if (isDirectory) {
          return pathname.endsWith('/')
            ? yield* textFileAt(path.join(filePath, INDEX))
            : Option.none<TextFile>()
        }
        if (Option.isSome(info)) {
          return yield* textFileAt(filePath)
        }
        return String.isEmpty(path.extname(filePath)) &&
          acceptsHtml(request.headers['accept'])
          ? yield* textFileAt(path.join(resolvedRoot, INDEX))
          : Option.none<TextFile>()
      })

    const compressedBody = (file: TextFile, encoding: Encoding) =>
      Cache.get(
        compressed,
        [file.filePath, encoding, file.size, file.modifiedMs].join(
          KEY_SEPARATOR,
        ),
      )

    /**
     * Compresses every text file of the build in the background, so the
     * first phone to open the app after a deploy does not wait for it.
     */
    yield* fs.readDirectory(resolvedRoot, { recursive: true }).pipe(
      Effect.flatMap(names =>
        Effect.forEach(
          names,
          name =>
            textFileAt(path.join(resolvedRoot, name)).pipe(
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.void,
                  onSome: file =>
                    Effect.forEach(ENCODING_PREFERENCE, encoding =>
                      Effect.ignore(compressedBody(file, encoding)),
                    ),
                }),
              ),
            ),
          { discard: true },
        ),
      ),
      Effect.ignore,
      Effect.forkScoped,
    )

    const sendCompressed = (
      request: HttpServerRequest.HttpServerRequest,
      file: TextFile,
      encoding: Encoding,
      cacheControl: string,
    ) =>
      Effect.gen(function* () {
        const etag = `"${file.size.toString(36)}-${file.modifiedMs.toString(36)}-${encoding}"`
        const headers = {
          'cache-control': cacheControl,
          etag,
          vary: 'Accept-Encoding',
        }
        if ((request.headers['if-none-match'] ?? '').includes(etag)) {
          return HttpServerResponse.empty({ status: 304, headers })
        }
        const body = yield* compressedBody(file, encoding)
        return HttpServerResponse.uint8Array(body, {
          contentType: file.contentType,
          headers: { ...headers, 'content-encoding': encoding },
        })
      })

    // NOTE: this returns the handler, an Effect run once per request.
    // @effect-diagnostics-next-line returnEffectInGen:off
    return Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const pathname = new URL(request.url, 'http://localhost').pathname
      const cacheControl = cacheControlFor(pathname)
      const maybeEncoding = preferredEncoding(
        request.headers['accept-encoding'],
      )
      const maybeFile = Option.isSome(maybeEncoding)
        ? yield* requestedTextFile(request, pathname)
        : Option.none<TextFile>()
      if (Option.isSome(maybeFile) && Option.isSome(maybeEncoding)) {
        const sent = yield* Effect.option(
          sendCompressed(
            request,
            maybeFile.value,
            maybeEncoding.value,
            cacheControl,
          ),
        )
        if (Option.isSome(sent)) {
          return sent.value
        }
      }
      const response = yield* (
        cacheControl === IMMUTABLE ? immutableFiles : revalidatedFiles
      ).pipe(Effect.catch(HttpServerRespondable.toResponse))
      return Option.isSome(
        Option.fromNullishOr(
          COMPRESSIBLE_TYPES[path.extname(pathname).toLowerCase()],
        ),
      )
        ? HttpServerResponse.setHeader(response, 'vary', 'Accept-Encoding')
        : response
    })
  })

/** The web app's route, when `WEB_DIST_DIR` says where the build is. */
export const WebAppRoutes = Layer.unwrap(
  Effect.gen(function* () {
    const maybeWebDistDir = yield* Config.option(Config.String('WEB_DIST_DIR'))
    return Option.match(maybeWebDistDir, {
      onNone: () => Layer.empty,
      onSome: root =>
        Layer.effectDiscard(
          Effect.gen(function* () {
            const router = yield* HttpRouter.HttpRouter
            const handler = yield* webAppRoute(root)
            yield* router.add('GET', '/*', handler)
          }),
        ),
    })
  }),
)
