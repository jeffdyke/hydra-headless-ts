/**
 * OAuth2 Token Service - Effect version with JWT support
 * Returns JWTs instead of Google's opaque access tokens
 * Uses Effect.gen for readable async code with dependency injection
 */
import { Effect } from 'effect'
import crypto from 'crypto'
import { decodeJwt } from 'jose'
import {
  PKCEStateSchema,
  AuthCodeDataSchema,
  GoogleTokenDataSchema,
  JWTRefreshDataSchema
} from '../domain.js'
import {
  type AppError,
  MissingParameter,
  UnauthorizedEmail,
} from '../errors.js'
import { isEmailAllowed } from './emailAllowlist.js'
import { validatePKCE, parseScopeString, validateScopes } from '../validation.js'
import { GoogleOAuthService } from './google.js'
import { JWTService } from './jwt.js'
import { RedisService, createOAuthRedisOps } from './redis.js'
import type {
  AuthCodeGrant,
  RefreshTokenGrant,
  OAuth2TokenResponse,
  GoogleTokenData} from '../domain.js';

/**
 * Process authorization_code grant type (Effect version)
 * Pipeline: Fetch auth data -> Validate PKCE -> Store Google tokens -> Generate JWT
 */
export const processAuthCodeGrant = (
  grant: AuthCodeGrant
): Effect.Effect<OAuth2TokenResponse, AppError, RedisService | JWTService> =>
  Effect.gen(function* () {
    // Access services from context
    const redis = yield* RedisService
    const jwt = yield* JWTService

    const redisOps = createOAuthRedisOps(redis)

    // Step 1: Fetch auth code data and PKCE state from Redis (parallel)
    const [authData, pkceState] = yield* Effect.all([
      redisOps.getAuthCode(grant.code, AuthCodeDataSchema),
      redisOps.getAuthCodeState(grant.code, PKCEStateSchema),
    ])

    // Step 2: Clean up one-time use auth codes (sequential)
    yield* redisOps.deleteAuthCode(grant.code)
    yield* redisOps.deleteAuthCodeState(grant.code)

    // Step 3: Validate PKCE
    yield* validatePKCE(
      grant.code_verifier,
      pkceState.code_challenge,
      pkceState.code_challenge_method
    )

    // Step 4: Generate JTI for this access token
    const jti = yield* jwt.generateJti()

    // Step 4.5: Re-validate email from Google ID token before issuing any token
    // (defense-in-depth — callback.ts already checked, but this catches any edge case
    // where an auth code was stored without a valid email check)
    const idTokenForGrant = authData.google_tokens.tokens.id_token
    if (idTokenForGrant) {
      const idPayload = decodeJwt(idTokenForGrant)
      const email = typeof idPayload['email'] === 'string' ? idPayload['email'] : undefined
      if (!email || !isEmailAllowed(email)) {
        yield* Effect.logWarning('Blocked unauthorized email at auth code grant').pipe(
          Effect.annotateLogs({ email: email ?? '<missing>' })
        )
        return yield* Effect.fail(new UnauthorizedEmail({ email: email ?? '<missing>' }))
      }
    }

    // Step 5: Store Google's tokens in Redis (indexed by JTI)
    const tokenObj = authData.google_tokens.tokens
    const googleTokenData: GoogleTokenData = {
      google_access_token: tokenObj.access_token,
      google_refresh_token: tokenObj.refresh_token ?? '',
      google_id_token: tokenObj.id_token,
      scope: tokenObj.scope,
      subject: authData.subject ?? 'user',
      client_id: pkceState.client_id,
      expires_at: Date.now() + (tokenObj.expires_in * 1000),
      updated_at: Date.now(),
    }

    yield* redisOps.setGoogleToken(jti, googleTokenData)

    yield* Effect.logTrace('Stored Google tokens').pipe(
      Effect.annotateLogs({ jti, subject: googleTokenData.subject })
    )

    // Step 6: Generate our own refresh token
    const ourRefreshToken = crypto.randomBytes(32).toString('base64url')

    // Step 7: Store JWT refresh data (mapping our refresh token to JTI)
    yield* redisOps.setJWTRefresh(ourRefreshToken, {
      jti,
      client_id: pkceState.client_id,
      scope: tokenObj.scope,
      subject: googleTokenData.subject,
      created_at: Date.now(),
    })

    // Step 8: Generate JWT access token
    // In Google mode, this returns the Google ID token directly
    // In Hydra mode, this signs a new JWT
    const accessToken = yield* jwt.sign(
      {
        sub: googleTokenData.subject,
        scope: tokenObj.scope,
        client_id: pkceState.client_id,
        jti,
      },
      tokenObj.expires_in,
      googleTokenData.google_id_token // Pass Google ID token for Google mode
    )

    // Step 9: Build OAuth2 token response with JWT
    const response: OAuth2TokenResponse = {
      access_token: accessToken, // JWT instead of Google's opaque token
      token_type: 'Bearer',
      expires_in: tokenObj.expires_in,
      refresh_token: ourRefreshToken, // Our own refresh token
      scope: tokenObj.scope,
    }

    yield* Effect.logInfo('Returning OAuth2 JWT token response').pipe(
      Effect.annotateLogs({ jti, subject: googleTokenData.subject })
    )

    return response
  })

/**
 * Process refresh_token grant type (Effect version)
 * Pipeline: Fetch JWT refresh data -> Get Google tokens -> Refresh if needed -> Generate new JWT
 */
export const processRefreshTokenGrant = (
  grant: RefreshTokenGrant
): Effect.Effect<
  OAuth2TokenResponse,
  AppError,
  RedisService | GoogleOAuthService | JWTService
> =>
  Effect.gen(function* () {
    // Access services
    const redis = yield* RedisService
    const google = yield* GoogleOAuthService
    const jwt = yield* JWTService

    const redisOps = createOAuthRedisOps(redis)

    // Step 1: Validate required fields
    if (!grant.refresh_token) {
      return yield* Effect.fail(new MissingParameter({ parameter: 'refresh_token' }))
    }

    const refreshToken = grant.refresh_token

    // Step 2: Fetch JWT refresh data (maps our refresh token to JTI)
    const jwtRefreshData = yield* redisOps.getJWTRefresh(
      refreshToken,
      JWTRefreshDataSchema
    )

    yield* Effect.logTrace('Fetched JWT refresh data').pipe(
      Effect.annotateLogs({ jti: jwtRefreshData.jti })
    )

    // Step 3: Fetch Google token data using JTI
    const googleTokenData = yield* redisOps.getGoogleToken(
      jwtRefreshData.jti,
      GoogleTokenDataSchema
    )

    // Step 3.5: Re-validate email from stored Google ID token
    if (googleTokenData.google_id_token) {
      const idPayload = decodeJwt(googleTokenData.google_id_token)
      const email = typeof idPayload['email'] === 'string' ? idPayload['email'] : undefined
      if (!email || !isEmailAllowed(email)) {
        yield* Effect.logWarning('Blocked unauthorized email at token refresh').pipe(
          Effect.annotateLogs({ email: email ?? '<missing>', jti: jwtRefreshData.jti })
        )
        return yield* Effect.fail(new UnauthorizedEmail({ email: email ?? '<missing>' }))
      }
    }

    // Step 4: Validate scopes if requested
    if (grant.scope) {
      const requestedScopes = parseScopeString(grant.scope)
      const grantedScopes = parseScopeString(googleTokenData.scope)

      yield* validateScopes(requestedScopes, grantedScopes)
    }

    // Step 5: Check if Google token needs refresh
    const now = Date.now()
    const needsRefresh = googleTokenData.expires_at < (now + 300000) // Refresh if < 5min left

    let newGoogleTokenData = googleTokenData
    let expiresIn = Math.floor((googleTokenData.expires_at - now) / 1000)

    if (needsRefresh) {
      yield* Effect.logDebug('Google token expired, refreshing').pipe(
        Effect.annotateLogs({ expires_at: googleTokenData.expires_at, now })
      )

      // Refresh Google's token
      const googleResponse = yield* google.refreshToken({
        client_id: googleTokenData.client_id,
        refresh_token: googleTokenData.google_refresh_token,
        access_token: googleTokenData.google_access_token,
        scope: googleTokenData.scope,
        subject: googleTokenData.subject,
        created_at: 0,
        expires_in: 0,
      })

      // Update Google token data
      newGoogleTokenData = {
        ...googleTokenData,
        google_access_token: googleResponse.access_token,
        google_refresh_token: googleResponse.refresh_token ?? googleTokenData.google_refresh_token,
        google_id_token: googleResponse.id_token ?? googleTokenData.google_id_token,
        expires_at: now + (googleResponse.expires_in * 1000),
        updated_at: now,
      }

      // Store updated Google tokens
      yield* redisOps.setGoogleToken(jwtRefreshData.jti, newGoogleTokenData)

      expiresIn = googleResponse.expires_in

      yield* Effect.logDebug('Google token refreshed and stored').pipe(
        Effect.annotateLogs({ jti: jwtRefreshData.jti })
      )
    } else {
      yield* Effect.logDebug('Google token still valid').pipe(
        Effect.annotateLogs({ expires_in: expiresIn })
      )
    }

    // Step 6: Generate new JWT access token (reusing same JTI)
    // In Google mode, this returns the Google ID token directly
    // In Hydra mode, this signs a new JWT
    const accessToken = yield* jwt.sign(
      {
        sub: newGoogleTokenData.subject,
        scope: newGoogleTokenData.scope,
        client_id: newGoogleTokenData.client_id,
        jti: jwtRefreshData.jti,
      },
      expiresIn,
      newGoogleTokenData.google_id_token // Pass Google ID token for Google mode
    )

    // Step 7: Build OAuth2 token response
    const response: OAuth2TokenResponse = {
      access_token: accessToken, // New JWT
      token_type: 'Bearer',
      expires_in: expiresIn,
      refresh_token: refreshToken, // Same refresh token
      scope: newGoogleTokenData.scope,
    }

    yield* Effect.logInfo('Returning refreshed JWT token response').pipe(
      Effect.annotateLogs({ jti: jwtRefreshData.jti, subject: newGoogleTokenData.subject })
    )

    return response
  })
