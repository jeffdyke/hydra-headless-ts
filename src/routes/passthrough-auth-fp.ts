/**
 * Functional OAuth2 token endpoint using Effect
 * This demonstrates the functional paradigm vs the imperative passthrough-auth.ts
 */
import { Effect } from 'effect'
import express from 'express'
import { decodeJwt } from 'jose'
import {
  TokenRequestSchema,
  AuthCodeGrantSchema,
  RefreshTokenGrantSchema,
  createOAuth2Error,
} from '../fp/domain.js'
import { type AppError, InvalidGrant } from '../fp/errors.js'
import {
  processAuthCodeGrant,
  processRefreshTokenGrant,
} from '../fp/services/token.js'
import { validateSchema } from '../fp/validation.js'
import type { GoogleOAuthService } from '../fp/services/google.js'
import type { JWTService } from '../fp/services/jwt.js'
import type { RedisService } from '../fp/services/redis.js'
import type { Layer } from 'effect';

const router = express.Router()

/**
 * Map application errors to OAuth2 error responses
 */
const mapErrorToOAuth2 = (error: AppError): { status: number; body: object } => {
  switch (error._tag) {
    // OAuth errors
    case 'InvalidPKCE':
      return {
        status: 400,
        body: createOAuth2Error('invalid_grant', 'PKCE validation failed'),
      }
    case 'InvalidGrant':
      return {
        status: 400,
        body: createOAuth2Error('invalid_grant', error.reason),
      }
    case 'InvalidScope':
      return {
        status: 400,
        body: createOAuth2Error('invalid_scope', 'Requested scope exceeds granted scope'),
      }
    case 'MissingParameter':
      return {
        status: 400,
        body: createOAuth2Error('invalid_request', `${error.parameter} required`),
      }
    case 'ExpiredToken':
      return {
        status: 400,
        body: createOAuth2Error('invalid_grant', 'Token expired'),
      }
    case 'UnauthorizedEmail':
      return {
        status: 403,
        body: createOAuth2Error('access_denied', 'Email not authorized'),
      }

    // Redis errors
    case 'RedisKeyNotFound':
      return {
        status: 400,
        body: createOAuth2Error('invalid_grant', 'Invalid or expired authorization code'),
      }

    // Google OAuth errors
    case 'GoogleAuthError':
      return {
        status: 400,
        body: createOAuth2Error('invalid_grant', error.errorDescription ?? error.error),
      }
    case 'GoogleTokenExpired':
    case 'GoogleTokenRevoked':
      return {
        status: 400,
        body: createOAuth2Error('invalid_grant', 'Refresh token expired or revoked'),
      }

    // Validation errors
    case 'SchemaValidationError':
      return {
        status: 400,
        body: createOAuth2Error('invalid_request', 'Invalid request parameters'),
      }
    case 'RequiredFieldMissing':
      return {
        status: 400,
        body: createOAuth2Error('invalid_request', `${error.field} required`),
      }

    // Generic errors
    default:
      return {
        status: 500,
        body: createOAuth2Error('server_error', 'Internal server error'),
      }
  }
}

/**
 * Main token endpoint handler (Effect version)
 *
 * This handler demonstrates:
 * 1. Pure validation using Effect Schema
 * 2. Discriminated unions for grant types
 * 3. Effect.gen for readable async code
 * 4. Context-based dependency injection via Layers
 * 5. No side effects in the handler - all IO wrapped in Effect
 */
export const createTokenHandler = (serviceLayer: Layer.Layer<RedisService | GoogleOAuthService | JWTService>) => {

  return async (req: express.Request, res: express.Response) => {

    const program = Effect.gen(function* () {
      // Log incoming request with comprehensive details
      yield* Effect.logInfo('=== TOKEN ENDPOINT CALLED ===').pipe(
        Effect.annotateLogs({
          method: req.method,
          path: req.path,
          grant_type: req.body?.grant_type,
          client_id: req.body?.client_id,
          has_code: !!req.body?.code,
          has_refresh_token: !!req.body?.refresh_token,
          has_code_verifier: !!req.body?.code_verifier,
          redirect_uri: req.body?.redirect_uri,
          scope: req.body?.scope,
          headers: {
            'content-type': req.headers['content-type'],
            'user-agent': req.headers['user-agent'],
            origin: req.headers.origin,
            referer: req.headers.referer,
          },
          ip: req.ip,
          timestamp: new Date().toISOString(),
        })
      )

      // Step 1: Validate request body using Effect Schema
      yield* Effect.logDebug('Validating token request schema')
      const tokenRequest = yield* validateSchema(TokenRequestSchema, req.body)
      yield* Effect.logDebug('Token request validated successfully').pipe(
        Effect.annotateLogs({ grant_type: tokenRequest.grant_type })
      )

      // Step 2: Process based on grant type (discriminated union)
      if (tokenRequest.grant_type === 'authorization_code') {
        yield* Effect.logDebug('Processing authorization_code grant').pipe(
          Effect.annotateLogs({
            code: `${tokenRequest.code?.substring(0, 50)}...`,
            client_id: tokenRequest.client_id,
          })
        )
        // Validate as auth code grant and process
        const grant = yield* validateSchema(AuthCodeGrantSchema, tokenRequest)
        const result = yield* processAuthCodeGrant(grant)
        yield* Effect.logDebug('Auth code grant processed successfully').pipe(
          Effect.annotateLogs({
            has_access_token: !!result.access_token,
            has_refresh_token: !!result.refresh_token,
            token_type: result.token_type,
            expires_in: result.expires_in,
          })
        )
        return result
      } else if (tokenRequest.grant_type === 'refresh_token') {
        yield* Effect.logDebug('Processing refresh_token grant').pipe(
          Effect.annotateLogs({
            refresh_token: `${tokenRequest.refresh_token?.substring(0, 50)}...`,
            client_id: tokenRequest.client_id
          })
        )
        // Validate as refresh token grant and process
        const grant = yield* validateSchema(RefreshTokenGrantSchema, tokenRequest)
        const result = yield* processRefreshTokenGrant(grant)
        return result

      } else {
        yield* Effect.logDebug('Unsupported grant type received').pipe(
          Effect.annotateLogs({ grant_type: (tokenRequest as any).grant_type })
        )
        return yield* Effect.fail(
          new InvalidGrant({
            reason: `Unsupported grant_type: ${(tokenRequest as any).grant_type}`,
          })
        )
      }
    }).pipe(
      // Provide service layer
      Effect.provide(serviceLayer)
    )

    // Step 3: Run the effect and handle result
    const result = await Effect.runPromise(
      Effect.either(program)
    )

    // Step 4: Send response based on result
    if (result._tag === 'Left') {
      const { status, body } = mapErrorToOAuth2(result.left)

      // Log error with full details
      await Effect.runPromise(
        Effect.logError('=== TOKEN ENDPOINT ERROR ===').pipe(
          Effect.annotateLogs({
            error_tag: result.left._tag,
            error_details: result.left,
            status,
            response_body: body,
            grant_type: req.body?.grant_type,
            client_id: req.body?.client_id,
            timestamp: new Date().toISOString(),
          }),
          Effect.provide(serviceLayer)
        )
      )

      res.status(status).json(body)
    } else {
      // Decode the access token to log its claims (helps verify what Claude.ai receives)
      let tokenClaims: Record<string, unknown> = {}
      try {
        tokenClaims = decodeJwt(result.right.access_token) as Record<string, unknown>
      } catch {
        // Non-JWT access token — leave claims empty
      }

      // Log success with token details (redacted)
      await Effect.runPromise(
        Effect.logInfo('=== TOKEN ENDPOINT SUCCESS ===').pipe(
          Effect.annotateLogs({
            grant_type: req.body?.grant_type,
            client_id: req.body?.client_id,
            token_type: result.right.token_type,
            expires_in: result.right.expires_in,
            has_access_token: !!result.right.access_token,
            has_refresh_token: !!result.right.refresh_token,
            scope: result.right.scope,
            access_token_preview: `${result.right.access_token.substring(0, 50)}...`,
            token_claims: {
              iss: tokenClaims['iss'],
              aud: tokenClaims['aud'],
              sub: tokenClaims['sub'],
              email: tokenClaims['email'],
              exp: tokenClaims['exp'],
              iat: tokenClaims['iat'],
              hd: tokenClaims['hd'],
            },
            timestamp: new Date().toISOString(),
          }),
          Effect.provide(serviceLayer)
        )
      )

      res.json(result.right)
    }
  }
}

/**
 * Router factory (will be used when we have service layer available)
 */
export const createTokenRouter = (serviceLayer: Layer.Layer<RedisService | GoogleOAuthService | JWTService>) => {
  router.post('/token', createTokenHandler(serviceLayer))
  return router
}

export default router
