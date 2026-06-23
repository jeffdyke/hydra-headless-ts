import { Effect, Either } from 'effect'
import { describe, it, expect, vi, beforeEach, assert } from 'vitest'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import { isEmailAllowed } from './emailAllowlist.js'
import { makeJWTService, type JWTConfig } from './jwt.js'
import { ParseError, UnauthorizedEmail } from '../errors.js'

vi.mock('./emailAllowlist.js', () => ({
  isEmailAllowed: vi.fn(),
}))

vi.mock('jose', () => ({
  SignJWT: vi.fn(),
  jwtVerify: vi.fn(),
  importJWK: vi.fn(),
  createRemoteJWKSet: vi.fn().mockReturnValue('mock-jwks'),
}))

vi.mock('../../logging-effect.js', () => ({
  syncLogger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}))

const googleConfig: JWTConfig = {
  provider: 'google',
  issuer: 'https://auth.example.com',
  audience: 'https://app.example.com',
  hydraPublicUrl: 'https://hydra.example.com',
  hydraAdminUrl: 'https://hydra.example.com',
}

const baseClaims = {
  sub: 'user-123',
  scope: 'openid profile email',
  client_id: 'test-client',
  jti: 'jti-abc123',
}

describe('JWTService email choke points', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(createRemoteJWKSet).mockReturnValue('mock-jwks' as any)
  })

  // ---------------------------------------------------------------------------
  // sign — Google mode
  // ---------------------------------------------------------------------------

  describe('sign (Google mode)', () => {
    it('rejects when email is not in the allowlist', async () => {
      vi.mocked(isEmailAllowed).mockReturnValue(false)

      const service = makeJWTService(googleConfig)
      const result = await Effect.runPromise(
        Effect.either(
          service.sign({ ...baseClaims, email: 'blocked@gmail.com' }, 3600, 'google-id-token')
        )
      )

      expect(result._tag).toBe('Left')
      assert(Either.isLeft(result))
      expect(result.left).toBeInstanceOf(ParseError)
      expect(isEmailAllowed).toHaveBeenCalledWith('blocked@gmail.com')
    })

    it('rejects when the email claim is not a string', async () => {
      // typeof undefined !== 'string' → blocked without calling isEmailAllowed
      const service = makeJWTService(googleConfig)
      const result = await Effect.runPromise(
        Effect.either(
          service.sign(baseClaims as any, 3600, 'google-id-token')
        )
      )

      expect(result._tag).toBe('Left')
      assert(Either.isLeft(result))
      expect(result.left).toBeInstanceOf(ParseError)
    })

    it('returns the Google ID token when email is allowed', async () => {
      vi.mocked(isEmailAllowed).mockReturnValue(true)

      const service = makeJWTService(googleConfig)
      const result = await Effect.runPromise(
        service.sign({ ...baseClaims, email: 'user@bondlink.com' }, 3600, 'expected-google-id-token')
      )

      expect(result).toBe('expected-google-id-token')
      expect(isEmailAllowed).toHaveBeenCalledWith('user@bondlink.com')
    })

    it('rejects when email is allowed but googleIdToken is absent', async () => {
      vi.mocked(isEmailAllowed).mockReturnValue(true)

      const service = makeJWTService(googleConfig)
      const result = await Effect.runPromise(
        Effect.either(
          service.sign({ ...baseClaims, email: 'user@bondlink.com' }, 3600)
        )
      )

      expect(result._tag).toBe('Left')
      assert(Either.isLeft(result))
      expect(result.left).toBeInstanceOf(ParseError)
    })
  })

  // ---------------------------------------------------------------------------
  // verify
  // ---------------------------------------------------------------------------

  describe('verify', () => {
    const validPayload = {
      sub: 'user-123',
      jti: 'jti-abc123',
      client_id: 'test-client',
      scope: 'openid',
      iat: 1000,
      exp: 9999999999,
    }

    it('rejects when verified claims contain an unauthorised email', async () => {
      vi.mocked(isEmailAllowed).mockReturnValue(false)
      vi.mocked(jwtVerify).mockResolvedValue({
        payload: { ...validPayload, email: 'blocked@gmail.com' },
        protectedHeader: { alg: 'RS256' },
      } as any)

      const service = makeJWTService(googleConfig)
      const result = await Effect.runPromise(
        Effect.either(service.verify('some.jwt.token'))
      )

      expect(result._tag).toBe('Left')
      assert(Either.isLeft(result))
      expect(result.left).toBeInstanceOf(UnauthorizedEmail)
      expect((result.left as UnauthorizedEmail).email).toBe('blocked@gmail.com')
      expect(isEmailAllowed).toHaveBeenCalledWith('blocked@gmail.com')
    })

    it('succeeds when claims have no email field (email check is skipped)', async () => {
      vi.mocked(jwtVerify).mockResolvedValue({
        payload: validPayload,
        protectedHeader: { alg: 'RS256' },
      } as any)

      const service = makeJWTService(googleConfig)
      const result = await Effect.runPromise(service.verify('some.jwt.token'))

      expect(result.sub).toBe('user-123')
      expect(isEmailAllowed).not.toHaveBeenCalled()
    })

    it('succeeds when email is in the allowlist', async () => {
      vi.mocked(isEmailAllowed).mockReturnValue(true)
      vi.mocked(jwtVerify).mockResolvedValue({
        payload: { ...validPayload, email: 'user@bondlink.com' },
        protectedHeader: { alg: 'RS256' },
      } as any)

      const service = makeJWTService(googleConfig)
      const result = await Effect.runPromise(service.verify('some.jwt.token'))

      expect(result.sub).toBe('user-123')
      expect(result.email).toBe('user@bondlink.com')
      expect(isEmailAllowed).toHaveBeenCalledWith('user@bondlink.com')
    })

    it('fails with ParseError when the token is invalid', async () => {
      vi.mocked(jwtVerify).mockRejectedValue(new Error('JWTExpired'))

      const service = makeJWTService(googleConfig)
      const result = await Effect.runPromise(
        Effect.either(service.verify('expired.jwt.token'))
      )

      expect(result._tag).toBe('Left')
      assert(Either.isLeft(result))
      expect(result.left).toBeInstanceOf(ParseError)
    })
  })
})
