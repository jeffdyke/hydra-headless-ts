/**
 * Client ID Metadata Document (CIMD) fetch + validation service
 * https://datatracker.ietf.org/doc/draft-ietf-oauth-client-id-metadata-document/
 *
 * A CIMD client's client_id IS an https:// URL. Instead of a DCR
 * registration call, the authorization server fetches a JSON metadata
 * document from that URL and treats it as the client's registered
 * metadata. Since the URL is attacker-controlled input (any MCP client can
 * point it anywhere), this module is the SSRF-sensitive boundary of the
 * feature: every resolved address is validated as public/routable BEFORE
 * connecting, and the same validated address is what the connection
 * actually uses (via a custom `lookup`), so there is no TOCTOU gap between
 * the check and the connect.
 */
import crypto from 'crypto'
import * as dns from 'dns'
import * as https from 'https'
import { Effect } from 'effect'
import ipaddr from 'ipaddr.js'
import { CimdMetadataSchema, type CimdMetadata } from '../domain.js'
import {
  CimdClientIdMismatch,
  CimdFetchTooLarge,
  CimdInvalidClientId,
  CimdRedirectRejected,
  CimdSsrfBlocked,
  NetworkError,
  TimeoutError,
  type CimdError,
  type HttpError,
  type SchemaValidationError,
} from '../errors.js'
import { validateSchema } from '../validation.js'
import type { CimdConfig } from '../config.js'

/**
 * Whether a client_id is CIMD-shaped (an https:// URL) rather than a
 * Hydra-opaque DCR client id. Pure/no network — used as the cheap gate in
 * setup/proxy.ts before anything CIMD-specific runs, so existing DCR
 * clients (UUIDs) fall through with zero added cost.
 */
export const isHttpsUrlClientId = (clientId: string): boolean => {
  let url: URL
  try {
    url = new URL(clientId)
  } catch {
    return false
  }
  if (url.protocol !== 'https:') return false
  if (url.username || url.password) return false
  if (url.hash) return false
  // Reject IP-literal hosts outright — CIMD client_ids are meant to be
  // stable, operator-controlled domains, and allowing an IP literal here
  // would let a caller skip DNS resolution (and the checks below) entirely.
  if (ipaddr.isValid(url.hostname.replace(/^\[|\]$/g, ''))) return false
  return true
}

/**
 * Is a resolved IP address safe to connect to (public, routable unicast)?
 * Denies loopback/private/link-local/unique-local/multicast/reserved
 * ranges for both IPv4 and IPv6, including IPv4-mapped IPv6 addresses
 * (::ffff:127.0.0.1 etc. — ipaddr.js's `range()` normalizes these).
 */
const isPubliclyRoutable = (address: string): boolean => {
  try {
    const addr = ipaddr.process(address)
    const range = addr.range()
    return range === 'unicast'
  } catch {
    return false
  }
}

const resolveAddresses = (hostname: string): Promise<dns.LookupAddress[]> =>
  new Promise((resolve, reject) => {
    dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err) reject(err)
      else resolve(addresses)
    })
  })

interface FetchResult {
  readonly status: number
  readonly headers: Record<string, string | string[] | undefined>
  readonly body: string
}

/**
 * Fetch a URL with the SSRF defenses this feature requires:
 *  - DNS resolved once, validated, and pinned via a custom `lookup` so the
 *    address actually connected to is the one that was validated (no
 *    re-resolution/rebinding window).
 *  - No redirects followed — any 3xx is a hard failure.
 *  - Hard timeout and a streamed byte-count cap enforced independently of
 *    any (spoofable) Content-Length header.
 */
const ssrfSafeFetch = (
  clientId: string,
  url: URL,
  config: CimdConfig
): Effect.Effect<FetchResult, CimdError | HttpError> =>
  Effect.tryPromise({
    try: () =>
      new Promise<FetchResult>((resolve, reject) => {
        resolveAddresses(url.hostname)
          .then((addresses) => {
            const blocked = addresses.find((a) => !isPubliclyRoutable(a.address))
            if (blocked) {
              reject(
                new CimdSsrfBlocked({
                  clientId,
                  host: url.hostname,
                  reason: `resolved address ${blocked.address} is not publicly routable`,
                })
              )
              return
            }
            if (addresses.length === 0) {
              reject(
                new CimdSsrfBlocked({
                  clientId,
                  host: url.hostname,
                  reason: 'hostname did not resolve to any address',
                })
              )
              return
            }

            // Pin the connection to exactly the addresses we just validated —
            // this `lookup` is what https.request actually calls to connect,
            // so there's no second, unvalidated resolution. Signature matches
            // net.LookupFunction, the (narrower) type https.request actually
            // expects for its `lookup` option — not the full overloaded
            // dns.lookup surface.
            const pinnedLookup = (
              _hostname: string,
              _options: dns.LookupOptions,
              callback: (err: NodeJS.ErrnoException | null, address: string, family: number) => void
            ): void => {
              const first = addresses[0]
              if (!first) return
              callback(null, first.address, first.family)
            }

            const req = https.request(
              url,
              {
                method: 'GET',
                lookup: pinnedLookup,
                servername: url.hostname,
                headers: { Accept: 'application/json' },
                timeout: config.fetchTimeoutMs,
              },
              (res) => {
                const status = res.statusCode ?? 0
                if (status >= 300 && status < 400) {
                  res.resume()
                  reject(
                    new CimdRedirectRejected({
                      clientId,
                      status,
                      location: (res.headers.location as string) ?? null,
                    })
                  )
                  return
                }

                const contentLength = Number(res.headers['content-length'] ?? 0)
                if (contentLength > config.maxResponseBytes) {
                  res.resume()
                  reject(new CimdFetchTooLarge({ clientId, maxBytes: config.maxResponseBytes }))
                  return
                }

                let received = 0
                const chunks: Buffer[] = []
                res.on('data', (chunk: Buffer) => {
                  received += chunk.length
                  if (received > config.maxResponseBytes) {
                    req.destroy()
                    reject(new CimdFetchTooLarge({ clientId, maxBytes: config.maxResponseBytes }))
                    return
                  }
                  chunks.push(chunk)
                })
                res.on('end', () => {
                  resolve({
                    status,
                    headers: res.headers,
                    body: Buffer.concat(chunks).toString('utf-8'),
                  })
                })
                res.on('error', (err) => reject(err))
              }
            )

            req.on('timeout', () => {
              req.destroy(new Error('timeout'))
              reject(new TimeoutError({ timeoutMs: config.fetchTimeoutMs }))
            })
            req.on('error', (err) => reject(err))
            req.end()
          })
          .catch((err: unknown) => {
            if (err instanceof Error && 'code' in err) {
              reject(
                new CimdSsrfBlocked({
                  clientId,
                  host: url.hostname,
                  reason: `DNS resolution failed: ${err.message}`,
                })
              )
            } else {
              reject(err)
            }
          })
      }),
    catch: (error): CimdError | HttpError => {
      if (
        error instanceof CimdSsrfBlocked ||
        error instanceof CimdRedirectRejected ||
        error instanceof CimdFetchTooLarge ||
        error instanceof TimeoutError
      ) {
        return error
      }
      return new NetworkError({ message: `CIMD fetch failed for ${clientId}`, cause: error })
    },
  })

/**
 * Fetch and validate the CIMD document at `clientId` (which must itself be
 * an https:// URL — callers should gate on `isHttpsUrlClientId` first).
 */
export const fetchCimdMetadata = (
  clientId: string,
  config: CimdConfig
): Effect.Effect<CimdMetadata, CimdError | HttpError | SchemaValidationError> =>
  Effect.gen(function* () {
    if (!isHttpsUrlClientId(clientId)) {
      return yield* Effect.fail(
        new CimdInvalidClientId({ clientId, reason: 'client_id is not an https:// URL' })
      )
    }
    const url = new URL(clientId)

    const response = yield* ssrfSafeFetch(clientId, url, config)

    if (response.status < 200 || response.status >= 300) {
      return yield* Effect.fail(
        new CimdInvalidClientId({
          clientId,
          reason: `metadata document fetch returned HTTP ${response.status}`,
        })
      )
    }

    const contentType = response.headers['content-type']
    if (typeof contentType !== 'string' || !contentType.includes('application/json')) {
      return yield* Effect.fail(
        new CimdInvalidClientId({
          clientId,
          reason: `expected application/json, got ${String(contentType)}`,
        })
      )
    }

    const parsed = yield* Effect.try({
      try: () => JSON.parse(response.body) as unknown,
      catch: () => new CimdInvalidClientId({ clientId, reason: 'response body is not valid JSON' }),
    })

    const metadata = yield* validateSchema(CimdMetadataSchema, parsed)

    if (metadata.client_id !== undefined && metadata.client_id !== clientId) {
      return yield* Effect.fail(
        new CimdClientIdMismatch({ clientId, documentClientId: metadata.client_id })
      )
    }

    return metadata
  })

/**
 * Stable content hash for change detection — used to decide whether a
 * previously shadow-registered Hydra client record needs re-upserting.
 */
export const cimdContentHash = (metadata: CimdMetadata): string =>
  crypto.createHash('sha256').update(JSON.stringify(metadata)).digest('hex')
