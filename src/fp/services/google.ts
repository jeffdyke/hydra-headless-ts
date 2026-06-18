/**
 * Google OAuth service using Effect for HTTP operations
 * All external calls return Effect for proper error handling
 *
 * Provides comprehensive Google OAuth operations including:
 * - Token refresh
 * - Auth URL generation
 * - Token exchange from code
 * - User info retrieval
 */
import axios from 'axios'
import { Effect, pipe, Context, Layer } from 'effect'
import { OAuth2Client } from 'google-auth-library'
import {
  GoogleTokenResponseSchema,
  GoogleUserInfoSchema
} from '../domain.js'
import { NetworkError, HttpStatusError, ParseError, GoogleAuthError } from '../errors.js'
import { validateSchema } from '../validation.js'
import type {
  GoogleTokenResponse,
  GoogleUserInfoResponse,
  RefreshTokenData} from '../domain.js';
import type { HttpError} from '../errors.js';
import type { AxiosError } from 'axios';

/**
 * Google OAuth service interface
 */
export interface GoogleOAuthService {
  readonly refreshToken: (
    tokenData: RefreshTokenData
  ) => Effect.Effect<GoogleTokenResponse, HttpError | GoogleAuthError>

  readonly generateAuthUrl: (
    scope: string,
    state: string,
    redirectUrl: string
  ) => Effect.Effect<string, HttpError>

  readonly getTokensFromCode: (
    code: string,
    redirectUrl: string
  ) => Effect.Effect<GoogleTokenResponse, HttpError | GoogleAuthError>

  readonly refreshAccessToken: (
    refreshToken: string
  ) => Effect.Effect<GoogleTokenResponse, HttpError | GoogleAuthError>

  readonly getUserInfo: (
    accessToken: string,
    idToken: string
  ) => Effect.Effect<GoogleUserInfoResponse, HttpError | GoogleAuthError>
}

/**
 * Google OAuth service tag
 */
export const GoogleOAuthService = Context.GenericTag<GoogleOAuthService>('GoogleOAuthService')

/**
 * Configuration for Google OAuth
 */
export interface GoogleOAuthConfig {
  clientId: string
  clientSecret: string
  redirectUri?: string
  tokenEndpoint?: string
  userInfoEndpoint?: string
}

/**
 * Create Google OAuth service implementation
 */
export const makeGoogleOAuthService = (
  config: GoogleOAuthConfig
): GoogleOAuthService => {
  const TOKEN_ENDPOINT = config.tokenEndpoint ?? 'https://oauth2.googleapis.com/token'
  const USER_INFO_ENDPOINT = config.userInfoEndpoint ?? 'https://www.googleapis.com/oauth2/v2/userinfo'

  // Create OAuth2Client if redirectUri is provided (for auth flow operations)
  const oauth2Client = config.redirectUri ? new OAuth2Client({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    redirectUri: config.redirectUri,
  }) : null

  /**
   * Helper to handle axios errors
   */
  const handleAxiosError = (error: unknown, operationName: string): HttpError | GoogleAuthError => {
    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError

      // Try to parse Google error response
      if (axiosError.response?.data) {
        try {
          const errorData = axiosError.response.data as any
          if (typeof errorData.error === 'string') {
            return new GoogleAuthError({
              error: errorData.error,
              errorDescription: errorData.error_description,
            })
          }
        } catch {
          // Fall through to generic HTTP error
        }
      }

      // Generic HTTP error
      return new HttpStatusError({
        status: axiosError.response?.status ?? 500,
        statusText: axiosError.response?.statusText ?? 'Unknown error',
        body: axiosError.response?.data,
      })
    }

    // Network or unknown error
    return new NetworkError({
      message: `Network error during ${operationName}`,
      cause: error,
    })
  }

  return {
    refreshToken: (tokenData: RefreshTokenData) =>
      pipe(
        Effect.logInfo('=== GOOGLE refreshToken CALLED ===').pipe(
          Effect.annotateLogs({
            has_refresh_token: !!tokenData.refresh_token,
            refresh_token_preview: tokenData.refresh_token ? `${tokenData.refresh_token.substring(0, 20)}...` : 'none',
            client_id: tokenData.client_id,
            scope: tokenData.scope,
            endpoint: TOKEN_ENDPOINT,
            timestamp: new Date().toISOString(),
          })
        ),
        Effect.andThen(() =>
          Effect.tryPromise({
            try: async () => {
              const response = await axios.post(
                TOKEN_ENDPOINT,
                new URLSearchParams({
                  client_id: config.clientId,
                  client_secret: config.clientSecret,
                  refresh_token: tokenData.refresh_token,
                  grant_type: 'refresh_token',
                }).toString(),
                {
                  headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                  },
                }
              )
              return response.data
            },
            catch: (error) => handleAxiosError(error, 'refreshToken'),
          })
        ),
        Effect.tap((data) =>
          Effect.logInfo('=== GOOGLE refreshToken RESPONSE ===').pipe(
            Effect.annotateLogs({
              has_access_token: !!(data as any).access_token,
              has_new_refresh_token: !!(data as any).refresh_token,
              expires_in: (data as any).expires_in,
              scope: (data as any).scope,
              timestamp: new Date().toISOString(),
            })
          )
        ),
        Effect.flatMap((data) => validateSchema(GoogleTokenResponseSchema, data)),
        Effect.tap((tokenResponse) =>
          Effect.logInfo('=== GOOGLE refreshToken SUCCESS ===').pipe(
            Effect.annotateLogs({
              expires_in: tokenResponse.expires_in,
              scope: tokenResponse.scope,
              has_new_refresh_token: !!tokenResponse.refresh_token,
              timestamp: new Date().toISOString(),
            })
          )
        ),
        Effect.tapError((error) =>
          Effect.logError('=== GOOGLE refreshToken ERROR ===').pipe(
            Effect.annotateLogs({
              error_tag: error._tag,
              error_details: error,
              timestamp: new Date().toISOString(),
            })
          )
        ),
        Effect.mapError(
          (error): HttpError | GoogleAuthError =>
            error._tag === 'SchemaValidationError'
              ? new ParseError({
                  message: `Failed to parse Google token response: ${error.errors.join(', ')}`,
                })
              : error
        )
      ),

    generateAuthUrl: (scope: string, state: string, redirectUrl: string) =>
      Effect.tryPromise({
        try: async () => {
          if (!oauth2Client) {
            throw new Error('OAuth2Client not initialized - redirectUri required in config')
          }
          const authUri = oauth2Client.generateAuthUrl({
            access_type: 'offline',
            scope,
            prompt: 'consent',
            state,
            response_type: 'code',
            redirect_uri: redirectUrl,
          })
          return authUri
        },
        catch: (error): HttpError =>
          new NetworkError({
            message: 'Failed to generate Google auth URL',
            cause: error,
          }),
      }),

    getTokensFromCode: (code: string, redirectUrl: string) =>
      pipe(
        Effect.logInfo('=== GOOGLE getTokensFromCode CALLED ===').pipe(
          Effect.annotateLogs({
            has_code: !!code,
            code_preview: code ? `${code.substring(0, 20)}...` : 'none',
            redirect_url: redirectUrl,
            timestamp: new Date().toISOString(),
          })
        ),
        Effect.andThen(() =>
          Effect.tryPromise({
            try: async () => {
              if (!oauth2Client) {
                throw new Error('OAuth2Client not initialized - redirectUri required in config')
              }
              const response = await oauth2Client.getToken({
                code,
                redirect_uri: redirectUrl,
              })
              return response.tokens
            },
            catch: (error) => handleAxiosError(error, 'getTokensFromCode'),
          })
        ),
        Effect.tap((data) =>
          Effect.logInfo('=== GOOGLE getTokensFromCode RESPONSE ===').pipe(
            Effect.annotateLogs({
              has_access_token: !!(data as any).access_token,
              has_refresh_token: !!(data as any).refresh_token,
              has_id_token: !!(data as any).id_token,
              expires_in: (data as any).expires_in,
              scope: (data as any).scope,
              timestamp: new Date().toISOString(),
            })
          )
        ),
        Effect.flatMap((data) => validateSchema(GoogleTokenResponseSchema, data)),
        Effect.tap((tokenResponse) =>
          Effect.logInfo('=== GOOGLE getTokensFromCode SUCCESS ===').pipe(
            Effect.annotateLogs({
              expires_in: tokenResponse.expires_in,
              scope: tokenResponse.scope,
              has_refresh_token: !!tokenResponse.refresh_token,
              has_id_token: !!tokenResponse.id_token,
              timestamp: new Date().toISOString(),
            })
          )
        ),
        Effect.tapError((error) =>
          Effect.logError('=== GOOGLE getTokensFromCode ERROR ===').pipe(
            Effect.annotateLogs({
              error_tag: error._tag,
              error_details: error,
              code_preview: code ? `${code.substring(0, 20)}...` : 'none',
              timestamp: new Date().toISOString(),
            })
          )
        ),
        Effect.mapError(
          (error): HttpError | GoogleAuthError =>
            error._tag === 'SchemaValidationError'
              ? new ParseError({
                  message: `Failed to parse Google token response: ${error.errors.join(', ')}`,
                })
              : error
        )
      ),

    refreshAccessToken: (refreshToken: string) =>
      pipe(
        Effect.tryPromise({
          try: async () => {
            const response = await axios.post(
              TOKEN_ENDPOINT,
              new URLSearchParams({
                grant_type: 'refresh_token',
                refresh_token: refreshToken,
                client_id: config.clientId,
                client_secret: config.clientSecret,
              }).toString(),
              {
                headers: {
                  'Content-Type': 'application/x-www-form-urlencoded',
                },
              }
            )
            return response.data
          },
          catch: (error) => handleAxiosError(error, 'refreshAccessToken'),
        }),
        Effect.flatMap((data) => validateSchema(GoogleTokenResponseSchema, data)),
        Effect.mapError(
          (error): HttpError | GoogleAuthError =>
            error._tag === 'SchemaValidationError'
              ? new ParseError({
                  message: `Failed to parse Google token response: ${error.errors.join(', ')}`,
                })
              : error
        )
      ),

    getUserInfo: (accessToken: string, idToken: string) =>
      pipe(
        Effect.logInfo('=== GOOGLE getUserInfo CALLED ===').pipe(
          Effect.annotateLogs({
            has_access_token: !!accessToken,
            access_token_preview: accessToken ? `${accessToken.substring(0, 20)}...` : 'none',
            has_id_token: !!idToken,
            id_token_preview: idToken ? `${idToken.substring(0, 20)}...` : 'none',
            endpoint: USER_INFO_ENDPOINT,
            timestamp: new Date().toISOString(),
          })
        ),
        Effect.andThen(() =>
          Effect.tryPromise({
            try: async () => {
              const url = `${USER_INFO_ENDPOINT}?alt=json&access_token=${accessToken}`
              const response = await axios.get(url, {
                headers: { Authorization: `Bearer ${idToken}` },
              })
              return response.data
            },
            catch: (error) => handleAxiosError(error, 'getUserInfo'),
          })
        ),
        Effect.tap((data) =>
          Effect.logInfo('=== GOOGLE getUserInfo RESPONSE ===').pipe(
            Effect.annotateLogs({
              has_email: !!(data as any).email,
              email: (data as any).email,
              has_verified_email: !!(data as any).verified_email,
              verified: (data as any).verified_email,
              timestamp: new Date().toISOString(),
            })
          )
        ),
        Effect.flatMap((data) => validateSchema(GoogleUserInfoSchema, data)),
        Effect.tap((userInfo) =>
          Effect.logInfo('=== GOOGLE getUserInfo SUCCESS ===').pipe(
            Effect.annotateLogs({
              email: userInfo.email,
              verified_email: userInfo.verified_email,
              has_name: !!userInfo.name,
              timestamp: new Date().toISOString(),
            })
          )
        ),
        Effect.tapError((error) =>
          Effect.logError('=== GOOGLE getUserInfo ERROR ===').pipe(
            Effect.annotateLogs({
              error_tag: error._tag,
              error_details: error,
              timestamp: new Date().toISOString(),
            })
          )
        ),
        Effect.mapError(
          (error): HttpError | GoogleAuthError =>
            error._tag === 'SchemaValidationError'
              ? new ParseError({
                  message: `Failed to parse Google user info response: ${error.errors.join(', ')}`,
                })
              : error
        )
      ),
  }
}

/**
 * Create a Layer for GoogleOAuthService
 */
export const GoogleOAuthServiceLive = (config: GoogleOAuthConfig) =>
  Layer.succeed(GoogleOAuthService, makeGoogleOAuthService(config))
