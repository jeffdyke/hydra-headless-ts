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

// Hydra mode fetches a signing key from the admin API when the service is
// constructed. Mocked so the hydra-mode tests below cannot reach the network.
vi.mock('axios', () => ({
  default: { get: vi.fn().mockRejectedValue(new Error('no network in tests')) },
}))

const googleConfig: JWTConfig = {
  provider: 'google',
  issuer: 'https://auth.example.com',
  audience: 'https://app.example.com',
  hydraPublicUrl: 'https://hydra.example.com',
  hydraAdminUrl: 'https://hydra.example.com',
}

const hydraConfig: JWTConfig = { ...googleConfig, provider: 'hydra' }

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
    it('returns the Google ID token when one is provided', async () => {
      const service = makeJWTService(googleConfig)
      const result = await Effect.runPromise(
        service.sign(baseClaims, 3600, 'expected-google-id-token')
      )

      expect(result).toBe('expected-google-id-token')
      // Email policy is enforced upstream in token.ts, not inside sign()
      expect(isEmailAllowed).not.toHaveBeenCalled()
    })

    it('rejects when googleIdToken is absent', async () => {
      const service = makeJWTService(googleConfig)
      const result = await Effect.runPromise(
        Effect.either(service.sign(baseClaims, 3600))
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

    // Hydra mode, not Google: Google mode now requires `email`, because it is
    // the identity the allowlist is keyed on. Hydra-signed tokens need not carry
    // one, and when they do not, the allowlist check is skipped rather than
    // failing.
    it('succeeds when claims have no email field (email check is skipped)', async () => {
      vi.mocked(jwtVerify).mockResolvedValue({
        payload: validPayload,
        protectedHeader: { alg: 'RS256' },
      } as any)

      const service = makeJWTService(hydraConfig)
      const result = await Effect.runPromise(service.verify('some.jwt.token'))

      expect(result.sub).toBe('user-123')
      expect(isEmailAllowed).not.toHaveBeenCalled()
    })

    // ---- required claims differ by provider -------------------------------
    // Google's ID token is passed through verbatim by sign(), and Google does
    // not issue jti or client_id. Demanding them rejected every genuine token,
    // so the app could not verify what it had just issued.

    it('accepts a realistic Google ID token: sub + email, no jti or client_id', async () => {
      vi.mocked(isEmailAllowed).mockReturnValue(true)
      vi.mocked(jwtVerify).mockResolvedValue({
        // Exactly Google's published claims_supported, nothing more.
        payload: {
          iss: 'https://accounts.google.com',
          aud: 'client-id.apps.googleusercontent.com',
          sub: 'google-user-123',
          email: 'user@bondlink.com',
          email_verified: true,
          iat: 1000,
          exp: 9999999999,
        },
        protectedHeader: { alg: 'RS256' },
      } as any)

      const service = makeJWTService(googleConfig)
      const result = await Effect.runPromise(service.verify('google.id.token'))

      expect(result.sub).toBe('google-user-123')
      expect(result.email).toBe('user@bondlink.com')
    })

    it('rejects a Google token with no email, naming the missing claim', async () => {
      vi.mocked(jwtVerify).mockResolvedValue({
        payload: { sub: 'google-user-123', iat: 1000, exp: 9999999999 },
        protectedHeader: { alg: 'RS256' },
      } as any)

      const service = makeJWTService(googleConfig)
      const result = await Effect.runPromise(
        Effect.either(service.verify('google.id.token'))
      )

      assert(Either.isLeft(result))
      expect(result.left).toBeInstanceOf(ParseError)
      expect((result.left as ParseError).message).toContain('email')
      expect((result.left as ParseError).message).toContain('google')
    })

    it('still rejects a Hydra token missing jti or client_id', async () => {
      for (const absent of ['jti', 'client_id'] as const) {
        vi.clearAllMocks()
        vi.mocked(createRemoteJWKSet).mockReturnValue('mock-jwks' as any)
        const payload: Record<string, unknown> = { ...validPayload }
        delete payload[absent]
        vi.mocked(jwtVerify).mockResolvedValue({
          payload,
          protectedHeader: { alg: 'RS256' },
        } as any)

        const service = makeJWTService(hydraConfig)
        const result = await Effect.runPromise(
          Effect.either(service.verify('hydra.jwt.token'))
        )

        assert(Either.isLeft(result))
        expect(result.left).toBeInstanceOf(ParseError)
        expect((result.left as ParseError).message).toContain(absent)
      }
    })

    it('rejects when sub is missing, whichever the provider', async () => {
      for (const cfg of [googleConfig, hydraConfig]) {
        vi.clearAllMocks()
        vi.mocked(createRemoteJWKSet).mockReturnValue('mock-jwks' as any)
        vi.mocked(jwtVerify).mockResolvedValue({
          payload: { ...validPayload, sub: undefined, email: 'user@bondlink.com' },
          protectedHeader: { alg: 'RS256' },
        } as any)

        const service = makeJWTService(cfg)
        const result = await Effect.runPromise(
          Effect.either(service.verify('some.jwt.token'))
        )

        assert(Either.isLeft(result))
        expect((result.left as ParseError).message).toContain('sub')
      }
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
