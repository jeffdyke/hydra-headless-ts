import { Effect } from 'effect'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { HttpStatusError, NetworkError } from '../errors.js'
import { makeHydraService, HydraServiceLive } from './hydra.js'
import type {
  OAuth2LoginRequest,
  AcceptOAuth2LoginRequest,
  OAuth2RedirectTo,
  OAuth2ConsentRequest,
  AcceptOAuth2ConsentRequest,
  OAuth2LogoutRequest,
} from '@ory/client-fetch'
import type { OAuth2Api } from '@ory/hydra-client-fetch/dist/index.js'


//TODO: Fix Tests mocking login request
// Mock OAuth2Api client
const createMockOAuth2Api = (): OAuth2Api => {
  return {
    getOAuth2LoginRequest: vi.fn(),
    acceptOAuth2LoginRequest: vi.fn(),
    getOAuth2ConsentRequest: vi.fn(),
    acceptOAuth2ConsentRequest: vi.fn(),
    getOAuth2LogoutRequest: vi.fn(),
    acceptOAuth2LogoutRequest: vi.fn(),
    rejectOAuth2LogoutRequest: vi.fn(),
  } as unknown as OAuth2Api
}

describe('HydraService', () => {
  let mockClient: OAuth2Api
  let hydraService: ReturnType<typeof makeHydraService>

  beforeEach(() => {
    mockClient = createMockOAuth2Api()
    hydraService = makeHydraService(mockClient)
  })

  describe('getLoginRequest', () => {
    it('should get login request successfully', async () => {
      const mockLoginRequest: OAuth2LoginRequest = {
        challenge: 'challenge-123',
        client: {
          client_id: 'test-client',
        },
        request_url: 'https://auth.example.com/oauth2/auth',
        skip: false,
        subject: '',

      }

      vi.mocked(mockClient.getOAuth2LoginRequest).mockResolvedValue(mockLoginRequest)

      const program = hydraService.getLoginRequest('challenge-123')
      const result = await Effect.runPromise(program)

      expect(result).toEqual(mockLoginRequest)
      expect(mockClient.getOAuth2LoginRequest).toHaveBeenCalledWith({
        loginChallenge: 'challenge-123',
      })
    })

    it('should handle HTTP errors', async () => {
      const httpError = {
        response: {
          status: 404,
          statusText: 'Not Found',
          data: { error: 'challenge not found' },
        },
      }

      vi.mocked(mockClient.getOAuth2LoginRequest).mockRejectedValue(httpError)

      const program = hydraService.getLoginRequest('invalid-challenge')
      const result = await Effect.runPromise(Effect.either(program))

      expect(result._tag).toBe('Left')
      if (result._tag === 'Left') {
        expect(result.left).toBeInstanceOf(HttpStatusError)
        const error = result.left as HttpStatusError
        expect(error.status).toBe(404)
      }
    })

    it('should handle network errors', async () => {
      vi.mocked(mockClient.getOAuth2LoginRequest).mockRejectedValue(
        new Error('Network timeout')
      )

      const program = hydraService.getLoginRequest('challenge-123')
      const result = await Effect.runPromise(Effect.either(program))

      expect(result._tag).toBe('Left')
      if (result._tag === 'Left') {
        expect(result.left).toBeInstanceOf(NetworkError)
      }
    })
  })

  describe('acceptLoginRequest', () => {
    it('should accept login request successfully', async () => {
      const acceptBody: AcceptOAuth2LoginRequest = {
        subject: 'user-123',
        remember: true,
        remember_for: 3600,
      }

      const mockRedirect: OAuth2RedirectTo = {
        redirect_to: 'https://auth.example.com/oauth2/auth?code=abc',
      }

      vi.mocked(mockClient.acceptOAuth2LoginRequest).mockResolvedValue(mockRedirect)

      const program = hydraService.acceptLoginRequest('challenge-123', acceptBody)
      const result = await Effect.runPromise(program)

      expect(result).toEqual(mockRedirect)
      expect(mockClient.acceptOAuth2LoginRequest).toHaveBeenCalledWith({
        loginChallenge: 'challenge-123',
        acceptOAuth2LoginRequest: acceptBody,
      })
    })

    it('should handle accept errors', async () => {
      const acceptBody: AcceptOAuth2LoginRequest = {
        subject: 'user-123',
      }

      vi.mocked(mockClient.acceptOAuth2LoginRequest).mockRejectedValue(
        new Error('Invalid subject')
      )

      const program = hydraService.acceptLoginRequest('challenge-123', acceptBody)
      const result = await Effect.runPromise(Effect.either(program))

      expect(result._tag).toBe('Left')
    })
  })

  describe('getConsentRequest', () => {
    it('should get consent request successfully', async () => {
      const mockConsentRequest: OAuth2ConsentRequest = {
        challenge: 'consent-challenge-123',
        client: {
          client_id: 'test-client',
        },
        request_url: 'https://auth.example.com/oauth2/auth',
        requested_scope: ['openid', 'profile'],
        skip: false,
        subject: 'user-123',
      }

      vi.mocked(mockClient.getOAuth2ConsentRequest).mockResolvedValue(mockConsentRequest)

      const program = hydraService.getConsentRequest('consent-challenge-123')
      const result = await Effect.runPromise(program)

      expect(result).toEqual(mockConsentRequest)
      expect(mockClient.getOAuth2ConsentRequest).toHaveBeenCalledWith({
        consentChallenge: 'consent-challenge-123',
      })
    })

    it('should handle missing consent challenge', async () => {
      const httpError = {
        response: {
          status: 404,
          statusText: 'Not Found',
          data: {},
        },
      }

      vi.mocked(mockClient.getOAuth2ConsentRequest).mockRejectedValue(httpError)

      const program = hydraService.getConsentRequest('invalid-challenge')
      const result = await Effect.runPromise(Effect.either(program))

      expect(result._tag).toBe('Left')
    })
  })

  describe('acceptConsentRequest', () => {
    it('should accept consent request successfully', async () => {
      const acceptBody: AcceptOAuth2ConsentRequest = {
        grant_scope: ['openid', 'profile'],
        grant_access_token_audience: ['https://api.example.com'],
        remember: true,
        remember_for: 3600,
      }

      const mockRedirect: OAuth2RedirectTo = {
        redirect_to: 'https://client.example.com/callback?code=xyz',
      }

      vi.mocked(mockClient.acceptOAuth2ConsentRequest).mockResolvedValue(mockRedirect)

      const program = hydraService.acceptConsentRequest('consent-123', acceptBody)
      const result = await Effect.runPromise(program)

      expect(result).toEqual(mockRedirect)
      expect(mockClient.acceptOAuth2ConsentRequest).toHaveBeenCalledWith({
        consentChallenge: 'consent-123',
        acceptOAuth2ConsentRequest: acceptBody,
      })
    })
  })

  describe('getLogoutRequest', () => {
    it('should get logout request successfully', async () => {
      const mockLogoutRequest: OAuth2LogoutRequest = {
        challenge: 'logout-challenge-123',
        subject: 'user-123',
        sid: 'session-123',
      }

      vi.mocked(mockClient.getOAuth2LogoutRequest).mockResolvedValue(mockLogoutRequest)

      const program = hydraService.getLogoutRequest('logout-challenge-123')
      const result = await Effect.runPromise(program)

      expect(result).toEqual(mockLogoutRequest)
      expect(mockClient.getOAuth2LogoutRequest).toHaveBeenCalledWith({
        logoutChallenge: 'logout-challenge-123',
      })
    })
  })

  describe('acceptLogoutRequest', () => {
    it('should accept logout request successfully', async () => {
      const mockRedirect: OAuth2RedirectTo = {
        redirect_to: 'https://auth.example.com/logout/success',
      }

      vi.mocked(mockClient.acceptOAuth2LogoutRequest).mockResolvedValue(mockRedirect)

      const program = hydraService.acceptLogoutRequest('logout-challenge-123')
      const result = await Effect.runPromise(program)

      expect(result).toEqual(mockRedirect)
      expect(mockClient.acceptOAuth2LogoutRequest).toHaveBeenCalledWith({
        logoutChallenge: 'logout-challenge-123',
      })
    })
  })

  describe('rejectLogoutRequest', () => {
    it('should reject logout request successfully', async () => {
      vi.mocked(mockClient.rejectOAuth2LogoutRequest).mockResolvedValue(undefined)

      const program = hydraService.rejectLogoutRequest('logout-challenge-123')
      await Effect.runPromise(program)

      expect(mockClient.rejectOAuth2LogoutRequest).toHaveBeenCalledWith({
        logoutChallenge: 'logout-challenge-123',
      })
    })

    it('should handle rejection errors', async () => {
      vi.mocked(mockClient.rejectOAuth2LogoutRequest).mockRejectedValue(
        new Error('Rejection failed')
      )

      const program = hydraService.rejectLogoutRequest('logout-challenge-123')
      const result = await Effect.runPromise(Effect.either(program))

      expect(result._tag).toBe('Left')
    })
  })

  describe('HydraServiceLive Layer', () => {
    it('should create a valid Layer', () => {
      const layer = HydraServiceLive(mockClient)

      expect(layer).toBeDefined()
    })
  })
})
