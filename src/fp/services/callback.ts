/**
 * Google OAuth callback business logic using Effect
 */
import * as crypto from 'crypto'
import { Effect } from 'effect'
import { decodeJwt } from 'jose'
import { PKCEStateSchema } from '../domain.js'
import { type AppError, GoogleAuthError, UnauthorizedEmail } from '../errors.js'
import { RedisService, createOAuthRedisOps } from './redis.js'
import { isEmailAllowed } from './emailAllowlist.js'
import type { AuthCodeData } from '../domain.js';

/**
 * Configuration for callback
 */
export interface CallbackConfig {
  readonly middlewareRedirectUri: string
}

/**
 * Google OAuth tokens (from google-auth-library)
 */
interface GoogleOAuthTokens {
  tokens: {
    access_token?: string | null
    refresh_token?: string | null
    scope?: string | null
    expires_in?: number | null
    id_token?: string | null
    token_type?: string | null
  }
}

/**
 * Google OAuth client interface
 */
export interface GoogleOAuthClient {
  getToken(code: string): Promise<GoogleOAuthTokens>
}

/**
 * Exchange Google authorization code for tokens
 * Using google-auth-library OAuth2Client
 */
const exchangeGoogleCode = (
  code: string,
  redirectUri: string,
  googleClient: GoogleOAuthClient
): Effect.Effect<GoogleOAuthTokens, GoogleAuthError> =>
  Effect.tryPromise({
    try: () => googleClient.getToken(code),
    catch: (error) =>
      new GoogleAuthError({
        error: 'token_exchange_failed',
        errorDescription: String(error),
      }),
  })

/**
 * Process OAuth callback
 * 1. Fetch PKCE state from Redis
 * 2. Exchange Google auth code for tokens
 * 3. Generate new auth_code for passthrough
 * 4. Store auth_code and state in Redis
 * 5. Delete PKCE session
 * 6. Build redirect URL with new auth_code
 */
export const processCallback = (
  googleCode: string,
  returnedState: string,
  pkceKey: string,
  googleClient: GoogleOAuthClient,
  config: CallbackConfig
): Effect.Effect<string, AppError, RedisService> =>
  Effect.gen(function* () {
    // Access services
    const redis = yield* RedisService

    const redisOps = createOAuthRedisOps(redis)

    yield* Effect.logInfo('Processing OAuth callback').pipe(
      Effect.annotateLogs({
        code: googleCode,
        returnedState,
        pkceKey,
      })
    )

    // Step 1: Fetch PKCE data from Redis
    const pkceData = yield* redisOps.getPKCEState(pkceKey, PKCEStateSchema)

    yield* Effect.logInfo('PKCE data fetched').pipe(
      Effect.annotateLogs({
        state: pkceData.state,
        challenge: pkceData.code_challenge,
      })
    )

    // Step 2: Exchange Google code for tokens
    const googleTokens = yield* exchangeGoogleCode(
      googleCode,
      config.middlewareRedirectUri,
      googleClient
    )

    // Step 3: Ensure required fields are present
    if (!googleTokens.tokens.access_token) {
      return yield* Effect.fail(
        new GoogleAuthError({
          error: 'missing_access_token',
          errorDescription: 'Google did not return an access token',
        })
      )
    }

    // Step 3.5: Validate email from Google ID token before storing anything
    const idToken = googleTokens.tokens.id_token
    if (!idToken) {
      return yield* Effect.fail(
        new GoogleAuthError({
          error: 'missing_id_token',
          errorDescription: 'Google did not return an ID token — ensure openid scope is requested',
        })
      )
    }

    const idPayload = decodeJwt(idToken)
    const email = typeof idPayload['email'] === 'string' ? idPayload['email'] : undefined
    if (!email || !isEmailAllowed(email)) {
      yield* Effect.logWarning('Blocked unauthorized email at callback').pipe(
        Effect.annotateLogs({ email: email ?? '<missing>' })
      )
      return yield* Effect.fail(new UnauthorizedEmail({ email: email ?? '<missing>' }))
    }

    // Step 4: Generate new auth_code for passthrough
    const authCode = crypto.randomBytes(32).toString('base64url')

    const authData: AuthCodeData = {
      google_tokens: {
        tokens: {
          access_token: googleTokens.tokens.access_token,
          scope: googleTokens.tokens.scope ?? '',
          expires_in: googleTokens.tokens.expires_in ?? 3600,
          token_type: googleTokens.tokens.token_type ?? 'Bearer',
          refresh_token: googleTokens.tokens.refresh_token ?? undefined,
          id_token: googleTokens.tokens.id_token ?? undefined,
        },
      },
      subject: undefined, // Will be populated from user info if needed
    }

    yield* Effect.logInfo('AuthData').pipe(Effect.annotateLogs({ authData }))
    yield* Effect.logInfo('Generated auth_code').pipe(Effect.annotateLogs({ authCode }))

    // Step 5: Store PKCE state and auth_code in Redis (sequential)
    yield* redisOps.setAuthCodeState(authCode, pkceData)
    yield* redisOps.setAuthCode(authCode, authData, 300)

    // Step 6: Delete PKCE session (cleanup) - catch errors to not fail the flow
    yield* Effect.catchAll(
      redisOps.deletePKCEState(pkceKey),
      (err) =>
        Effect.logError('Failed to delete PKCE session').pipe(
          Effect.annotateLogs({ err, pkceKey })
        )
    )

    // Step 7: Build redirect URL
    const ptCallback = new URL(pkceData.redirect_uri)
    ptCallback.searchParams.set('code', authCode)
    ptCallback.searchParams.set('state', pkceData.state)

    yield* Effect.logInfo('Callback complete, redirecting').pipe(
      Effect.annotateLogs({
        redirectUri: ptCallback.toString(),
      })
    )

    return ptCallback.toString()
  })
