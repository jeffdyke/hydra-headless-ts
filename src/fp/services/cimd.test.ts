import * as dns from 'dns'
import { EventEmitter } from 'events'
import * as https from 'https'
import { Effect } from 'effect'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  CimdClientIdMismatch,
  CimdFetchTooLarge,
  CimdRedirectRejected,
  CimdSsrfBlocked,
  SchemaValidationError,
} from '../errors.js'
import { cimdContentHash, fetchCimdMetadata, isHttpsUrlClientId } from './cimd.js'
import type { CimdConfig } from '../config.js'
import type { CimdMetadata } from '../domain.js'

vi.mock('dns', () => ({ lookup: vi.fn() }))
vi.mock('https', () => ({ request: vi.fn() }))

const config: CimdConfig = {
  enabled: true,
  fetchTimeoutMs: 3000,
  maxResponseBytes: 65536,
  cacheTtlSeconds: 300,
}

/** Fake req/res pair driving the https.request(url, options, callback) mock. */
class FakeRequest extends EventEmitter {
  destroy = vi.fn()
  end = vi.fn()
}

class FakeResponse extends EventEmitter {
  constructor(
    public statusCode: number,
    public headers: Record<string, string>
  ) {
    super()
  }
  resume = vi.fn()
}

/** Wires https.request so the callback fires with `res`, then streams `body`. */
const mockHttpsResponse = (statusCode: number, headers: Record<string, string>, body: string) => {
  const req = new FakeRequest()
  vi.mocked(https.request).mockImplementation((_url, _options, callback) => {
    const res = new FakeResponse(statusCode, headers)
    // Defer so the caller can attach req.on('error'/'timeout') first.
    queueMicrotask(() => {
      ;(callback as unknown as (res: FakeResponse) => void)(res)
      if (body) res.emit('data', Buffer.from(body))
      res.emit('end')
    })
    return req as unknown as ReturnType<typeof https.request>
  })
  return req
}

const validMetadata: CimdMetadata = {
  redirect_uris: ['https://client.example/callback'],
  grant_types: ['authorization_code'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
}

describe('isHttpsUrlClientId', () => {
  it('accepts a well-formed https URL', () => {
    expect(isHttpsUrlClientId('https://client.example/metadata.json')).toBe(true)
  })

  it('rejects http (non-https) URLs', () => {
    expect(isHttpsUrlClientId('http://client.example/metadata.json')).toBe(false)
  })

  it('rejects opaque (non-URL) client ids', () => {
    expect(isHttpsUrlClientId('a1b2c3d4-e5f6-7890-abcd-ef1234567890')).toBe(false)
  })

  it('rejects IP-literal hosts', () => {
    expect(isHttpsUrlClientId('https://203.0.113.5/metadata.json')).toBe(false)
  })

  it('rejects URLs with embedded userinfo', () => {
    expect(isHttpsUrlClientId('https://user:pass@client.example/metadata.json')).toBe(false)
  })

  it('rejects URLs with a fragment', () => {
    expect(isHttpsUrlClientId('https://client.example/metadata.json#frag')).toBe(false)
  })
})

describe('fetchCimdMetadata', () => {
  const clientId = 'https://client.example/metadata.json'

  beforeEach(() => {
    vi.clearAllMocks()
    // 8.8.8.8 is a real, publicly routable unicast address (not one of the
    // TEST-NET/documentation ranges, which ipaddr.js correctly classifies
    // as "reserved" rather than "unicast" and would make this default mock
    // itself trip the SSRF guard).
    vi.mocked(dns.lookup).mockImplementation(((_hostname: string, _opts: unknown, cb: any) => {
      cb(null, [{ address: '8.8.8.8', family: 4 }])
    }) as typeof dns.lookup)
  })

  it('fetches and validates a well-formed document', async () => {
    mockHttpsResponse(200, { 'content-type': 'application/json' }, JSON.stringify(validMetadata))

    const result = await Effect.runPromise(fetchCimdMetadata(clientId, config))

    expect(result.redirect_uris).toEqual(['https://client.example/callback'])
    expect(result.token_endpoint_auth_method).toBe('none')
  })

  it('rejects when every resolved address is private/loopback', async () => {
    vi.mocked(dns.lookup).mockImplementation(((_hostname: string, _opts: unknown, cb: any) => {
      cb(null, [{ address: '127.0.0.1', family: 4 }])
    }) as typeof dns.lookup)

    const result = await Effect.runPromise(Effect.either(fetchCimdMetadata(clientId, config)))

    expect(result._tag).toBe('Left')
    if (result._tag === 'Left') {
      expect(result.left).toBeInstanceOf(CimdSsrfBlocked)
    }
  })

  it('rejects when a resolved address is a private range (10.0.0.0/8)', async () => {
    vi.mocked(dns.lookup).mockImplementation(((_hostname: string, _opts: unknown, cb: any) => {
      cb(null, [{ address: '10.1.2.3', family: 4 }])
    }) as typeof dns.lookup)

    const result = await Effect.runPromise(Effect.either(fetchCimdMetadata(clientId, config)))

    expect(result._tag).toBe('Left')
    if (result._tag === 'Left') {
      expect(result.left).toBeInstanceOf(CimdSsrfBlocked)
    }
  })

  it('rejects an IPv4-mapped IPv6 loopback address (::ffff:127.0.0.1)', async () => {
    vi.mocked(dns.lookup).mockImplementation(((_hostname: string, _opts: unknown, cb: any) => {
      cb(null, [{ address: '::ffff:127.0.0.1', family: 6 }])
    }) as typeof dns.lookup)

    const result = await Effect.runPromise(Effect.either(fetchCimdMetadata(clientId, config)))

    expect(result._tag).toBe('Left')
    if (result._tag === 'Left') {
      expect(result.left).toBeInstanceOf(CimdSsrfBlocked)
    }
  })

  it('rejects a 3xx response instead of following the redirect', async () => {
    mockHttpsResponse(302, { location: 'https://evil.example/metadata.json' }, '')

    const result = await Effect.runPromise(Effect.either(fetchCimdMetadata(clientId, config)))

    expect(result._tag).toBe('Left')
    if (result._tag === 'Left') {
      expect(result.left).toBeInstanceOf(CimdRedirectRejected)
    }
  })

  it('rejects a response whose Content-Length exceeds the configured cap', async () => {
    mockHttpsResponse(
      200,
      { 'content-type': 'application/json', 'content-length': String(config.maxResponseBytes + 1) },
      '{}'
    )

    const result = await Effect.runPromise(Effect.either(fetchCimdMetadata(clientId, config)))

    expect(result._tag).toBe('Left')
    if (result._tag === 'Left') {
      expect(result.left).toBeInstanceOf(CimdFetchTooLarge)
    }
  })

  it('rejects a streamed body exceeding the cap even without a Content-Length header', async () => {
    const oversized = 'x'.repeat(config.maxResponseBytes + 1)
    mockHttpsResponse(200, { 'content-type': 'application/json' }, oversized)

    const result = await Effect.runPromise(Effect.either(fetchCimdMetadata(clientId, config)))

    expect(result._tag).toBe('Left')
    if (result._tag === 'Left') {
      expect(result.left).toBeInstanceOf(CimdFetchTooLarge)
    }
  })

  it('rejects a non-JSON content-type', async () => {
    mockHttpsResponse(200, { 'content-type': 'text/html' }, '<html></html>')

    const result = await Effect.runPromise(Effect.either(fetchCimdMetadata(clientId, config)))

    expect(result._tag).toBe('Left')
  })

  it('rejects a document missing redirect_uris', async () => {
    mockHttpsResponse(
      200,
      { 'content-type': 'application/json' },
      JSON.stringify({ token_endpoint_auth_method: 'none' })
    )

    const result = await Effect.runPromise(Effect.either(fetchCimdMetadata(clientId, config)))

    expect(result._tag).toBe('Left')
    if (result._tag === 'Left') {
      expect(result.left).toBeInstanceOf(SchemaValidationError)
    }
  })

  it('rejects a document claiming a confidential token_endpoint_auth_method', async () => {
    mockHttpsResponse(
      200,
      { 'content-type': 'application/json' },
      JSON.stringify({ ...validMetadata, token_endpoint_auth_method: 'client_secret_post' })
    )

    const result = await Effect.runPromise(Effect.either(fetchCimdMetadata(clientId, config)))

    expect(result._tag).toBe('Left')
    if (result._tag === 'Left') {
      expect(result.left).toBeInstanceOf(SchemaValidationError)
    }
  })

  it('rejects when the document embeds a different client_id than the fetch URL', async () => {
    mockHttpsResponse(
      200,
      { 'content-type': 'application/json' },
      JSON.stringify({ ...validMetadata, client_id: 'https://someone-else.example/metadata.json' })
    )

    const result = await Effect.runPromise(Effect.either(fetchCimdMetadata(clientId, config)))

    expect(result._tag).toBe('Left')
    if (result._tag === 'Left') {
      expect(result.left).toBeInstanceOf(CimdClientIdMismatch)
    }
  })

  it('accepts when the document embeds a client_id matching the fetch URL', async () => {
    mockHttpsResponse(
      200,
      { 'content-type': 'application/json' },
      JSON.stringify({ ...validMetadata, client_id: clientId })
    )

    const result = await Effect.runPromise(fetchCimdMetadata(clientId, config))
    expect(result.redirect_uris).toEqual(validMetadata.redirect_uris)
  })
})

describe('cimdContentHash', () => {
  it('is stable for identical metadata', () => {
    expect(cimdContentHash(validMetadata)).toBe(cimdContentHash({ ...validMetadata }))
  })

  it('changes when metadata changes', () => {
    const changed: CimdMetadata = { ...validMetadata, redirect_uris: ['https://client.example/other'] }
    expect(cimdContentHash(validMetadata)).not.toBe(cimdContentHash(changed))
  })
})
