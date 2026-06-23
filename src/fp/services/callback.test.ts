import { Effect, Layer } from 'effect'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { decodeJwt } from 'jose'
import { isEmailAllowed } from './emailAllowlist.js'
import { processCallback, type GoogleOAuthClient } from './callback.js'
import { RedisService } from './redis.js'
import { GoogleAuthError, UnauthorizedEmail } from '../errors.js'
import type { PKCEState } from '../domain.js'

vi.mock('./emailAllowlist.js', () => ({ isEmailAllowed: vi.fn() }))
vi.mock('jose', () => ({ decodeJwt: vi.fn() }))
vi.mock('../../logging-effect.js', () => ({
  syncLogger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}))

// Fixture: valid PKCE state stored in Redis
const validPKCEState: PKCEState = {
  code_challenge: 'test-challenge-abc123',
  code_challenge_method: 'S256',
  scope: 'openid',
  state: 'test-state-xyz',
  redirect_uri: 'https://client.example.com/callback',
  client_id: 'test-client',
  timestamp: Date.now(),
}

// Fixture: Google token response with all fields
const fullGoogleTokens = {
  tokens: {
    access_token: 'ga-access-token',
    refresh_token: 'ga-refresh-token',
    scope: 'openid',
    expires_in: 3600,
    token_type: 'Bearer',
    id_token: 'google-id-token',
  },
}

const makeTestRedis = (): { redis: RedisService; getJSON: ReturnType<typeof vi.fn> } => {
  const getJSON = vi.fn().mockReturnValue(Effect.succeed(validPKCEState))
  const redis = {
    get: () => Effect.succeed(null),
    getJSON,
    set: () => Effect.succeed('OK' as const),
    setJSON: () => Effect.succeed('OK' as const),
    del: () => Effect.succeed(1),
    exists: () => Effect.succeed(1),
  } as unknown as RedisService
  return { redis, getJSON }
}

const makeGoogleClient = (overrideTokens?: object): GoogleOAuthClient => ({
  getToken: vi.fn().mockResolvedValue(overrideTokens ?? fullGoogleTokens),
})

const run = (redis: RedisService, googleClient?: GoogleOAuthClient) =>
  Effect.runPromise(
    Effect.either(
      Effect.provide(
        processCallback(
          'google-code-123',
          'test-state-xyz',
          'test-pkce-key',
          googleClient ?? makeGoogleClient(),
          { middlewareRedirectUri: 'https://auth.example.com/callback' }
        ),
        Layer.succeed(RedisService, redis)
      )
    )
  )

describe('processCallback email choke point', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('rejects when the email from the ID token is not in the allowlist', async () => {
    vi.mocked(isEmailAllowed).mockReturnValue(false)
    vi.mocked(decodeJwt).mockReturnValue({ email: 'blocked@gmail.com' } as any)

    const { redis } = makeTestRedis()
    const result = await run(redis)

    expect(result._tag).toBe('Left')
    expect(result.left).toBeInstanceOf(UnauthorizedEmail)
    expect((result.left as UnauthorizedEmail).email).toBe('blocked@gmail.com')
    expect(isEmailAllowed).toHaveBeenCalledWith('blocked@gmail.com')
  })

  it('rejects with <missing> when the ID token has no email field', async () => {
    // decodeJwt returns payload with no email → email is undefined → blocked
    vi.mocked(decodeJwt).mockReturnValue({} as any)

    const { redis } = makeTestRedis()
    const result = await run(redis)

    expect(result._tag).toBe('Left')
    expect(result.left).toBeInstanceOf(UnauthorizedEmail)
    expect((result.left as UnauthorizedEmail).email).toBe('<missing>')
    expect(isEmailAllowed).not.toHaveBeenCalled()
  })

  it('rejects with GoogleAuthError when Google returns no ID token', async () => {
    const { redis } = makeTestRedis()
    const result = await run(redis, makeGoogleClient({
      tokens: {
        access_token: 'ga-access-token',
        scope: 'openid',
        expires_in: 3600,
        token_type: 'Bearer',
        // no id_token
      },
    }))

    expect(result._tag).toBe('Left')
    expect(result.left).toBeInstanceOf(GoogleAuthError)
    expect((result.left as GoogleAuthError).error).toBe('missing_id_token')
    expect(isEmailAllowed).not.toHaveBeenCalled()
  })

  it('rejects with GoogleAuthError when Google returns no access token', async () => {
    const { redis } = makeTestRedis()
    const result = await run(redis, makeGoogleClient({
      tokens: {
        // no access_token
        scope: 'openid',
        expires_in: 3600,
        token_type: 'Bearer',
        id_token: 'google-id-token',
      },
    }))

    expect(result._tag).toBe('Left')
    expect(result.left).toBeInstanceOf(GoogleAuthError)
    expect((result.left as GoogleAuthError).error).toBe('missing_access_token')
  })

  it('returns a redirect URL when the email is in the allowlist', async () => {
    vi.mocked(isEmailAllowed).mockReturnValue(true)
    vi.mocked(decodeJwt).mockReturnValue({ email: 'user@bondlink.com' } as any)

    const { redis } = makeTestRedis()
    const result = await run(redis)

    expect(result._tag).toBe('Right')
    expect(result.right).toContain('https://client.example.com/callback')
    expect(result.right).toContain('code=')
    expect(result.right).toContain('state=test-state-xyz')
    expect(isEmailAllowed).toHaveBeenCalledWith('user@bondlink.com')
  })
})
