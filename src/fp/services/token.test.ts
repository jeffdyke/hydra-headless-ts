import { Effect, Layer } from 'effect'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { decodeJwt } from 'jose'
import { isEmailAllowed } from './emailAllowlist.js'
import { processRefreshTokenGrant } from './token.js'
import { RedisService } from './redis.js'
import { GoogleOAuthService } from './google.js'
import { JWTService } from './jwt.js'
import { UnauthorizedEmail, ParseError } from '../errors.js'
import type { JWTRefreshData, GoogleTokenData } from '../domain.js'

vi.mock('./emailAllowlist.js', () => ({ isEmailAllowed: vi.fn() }))
vi.mock('jose', () => ({ decodeJwt: vi.fn() }))
vi.mock('../../logging-effect.js', () => ({
  syncLogger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}))

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const validJWTRefreshData: JWTRefreshData = {
  jti: 'test-jti',
  client_id: 'test-client',
  scope: 'openid',
  subject: 'user-123',
  created_at: Date.now(),
}

const validGoogleTokenData: GoogleTokenData = {
  google_access_token: 'ga-access-token',
  google_refresh_token: 'ga-refresh-token',
  google_id_token: 'google-id-token',
  scope: 'openid',
  subject: 'user-123',
  client_id: 'test-client',
  expires_at: Date.now() + 3_600_000, // 1 hour from now — no refresh needed
  updated_at: Date.now(),
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeTestRedis = (
  jwtRefreshData = validJWTRefreshData,
  googleTokenData: GoogleTokenData = validGoogleTokenData
): RedisService => {
  const getJSON = vi.fn()
    .mockReturnValueOnce(Effect.succeed(jwtRefreshData))   // Step 2: getJWTRefresh
    .mockReturnValueOnce(Effect.succeed(googleTokenData))  // Step 3: getGoogleToken
  return {
    get: () => Effect.succeed(null),
    getJSON,
    set: () => Effect.succeed('OK' as const),
    setJSON: () => Effect.succeed('OK' as const),
    del: () => Effect.succeed(1),
    exists: () => Effect.succeed(1),
  } as unknown as RedisService
}

// Stub for GoogleOAuthService — only used when token needs refresh (expires_at < now+5min).
// Our fixture sets expires_at 1hr from now so refreshToken is never called in these tests.
const stubGoogleOAuth = {
  refreshToken: () => Effect.fail(new ParseError({ message: 'stub: should not be called' })),
  generateAuthUrl: () => Effect.fail(new ParseError({ message: 'stub' })),
  getTokensFromCode: () => Effect.fail(new ParseError({ message: 'stub' })),
  refreshAccessToken: () => Effect.fail(new ParseError({ message: 'stub' })),
  getUserInfo: () => Effect.fail(new ParseError({ message: 'stub' })),
} as unknown as GoogleOAuthService

// Stub for JWTService — only called after the email check passes.
const stubJWT = {
  sign: () => Effect.succeed('stub-access-token'),
  verify: () => Effect.fail(new ParseError({ message: 'stub' })),
  generateJti: () => Effect.succeed('stub-jti'),
  getJWKS: () => Effect.fail(new ParseError({ message: 'stub' })),
} as unknown as JWTService

const run = (redis: RedisService) => {
  const layer = Layer.merge(
    Layer.merge(
      Layer.succeed(RedisService, redis),
      Layer.succeed(GoogleOAuthService, stubGoogleOAuth)
    ),
    Layer.succeed(JWTService, stubJWT)
  )
  return Effect.runPromise(
    Effect.either(
      Effect.provide(
        processRefreshTokenGrant({
          grant_type: 'refresh_token',
          refresh_token: 'test-refresh-token',
          client_id: 'test-client',
        }),
        layer
      )
    )
  )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('processRefreshTokenGrant email choke point', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('rejects when the stored google_id_token contains a blocked email', async () => {
    vi.mocked(isEmailAllowed).mockReturnValue(false)
    vi.mocked(decodeJwt).mockReturnValue({ email: 'blocked@gmail.com' } as any)

    const redis = makeTestRedis()
    const result = await run(redis)

    expect(result._tag).toBe('Left')
    expect(result.left).toBeInstanceOf(UnauthorizedEmail)
    expect((result.left as UnauthorizedEmail).email).toBe('blocked@gmail.com')
    expect(isEmailAllowed).toHaveBeenCalledWith('blocked@gmail.com')
  })

  it('rejects with <missing> when the ID token payload has no email field', async () => {
    vi.mocked(decodeJwt).mockReturnValue({} as any) // no email field

    const redis = makeTestRedis()
    const result = await run(redis)

    expect(result._tag).toBe('Left')
    expect(result.left).toBeInstanceOf(UnauthorizedEmail)
    expect((result.left as UnauthorizedEmail).email).toBe('<missing>')
    expect(isEmailAllowed).not.toHaveBeenCalled()
  })

  it('skips the email check and succeeds when google_id_token is absent', async () => {
    // Store token data without an id_token — email check is entirely skipped
    const tokenDataWithoutIdToken: GoogleTokenData = {
      ...validGoogleTokenData,
      google_id_token: undefined,
    }

    const redis = makeTestRedis(validJWTRefreshData, tokenDataWithoutIdToken)
    const result = await run(redis)

    expect(result._tag).toBe('Right')
    expect(result.right).toMatchObject({
      access_token: 'stub-access-token',
      token_type: 'Bearer',
      refresh_token: 'test-refresh-token',
    })
    expect(decodeJwt).not.toHaveBeenCalled()
    expect(isEmailAllowed).not.toHaveBeenCalled()
  })

  it('succeeds and returns a token response when email is in the allowlist', async () => {
    vi.mocked(isEmailAllowed).mockReturnValue(true)
    vi.mocked(decodeJwt).mockReturnValue({ email: 'user@bondlink.com' } as any)

    const redis = makeTestRedis()
    const result = await run(redis)

    expect(result._tag).toBe('Right')
    expect(result.right).toMatchObject({
      access_token: 'stub-access-token',
      token_type: 'Bearer',
      refresh_token: 'test-refresh-token',
      scope: 'openid',
    })
    expect(isEmailAllowed).toHaveBeenCalledWith('user@bondlink.com')
  })
})
