/**
 * JWT Service using Effect and jose
 * Generates and verifies JWTs for OAuth2 token responses
 * Fetches signing keys from Hydra's JWKS endpoint
 */
import { Effect, Context, Layer } from 'effect'
import {
  SignJWT,
  jwtVerify,
  importJWK,
  createRemoteJWKSet,
  type JWTPayload,
  type JWK,
} from 'jose'
import axios from 'axios'
import crypto from 'crypto'
import { ParseError, NetworkError, UnauthorizedEmail, type AppError } from '../errors.js'
import { syncLogger } from '../../logging-effect.js'
import { isEmailAllowed } from './emailAllowlist.js'

/**
 * JWT Claims structure
 */
export interface JWTClaims extends JWTPayload {
  sub: string // Subject (user ID)
  scope: string // Space-separated scopes
  client_id: string // OAuth2 client ID
  jti: string // JWT ID (unique identifier for this token)
  kid?: string // Key ID (identifies which key was used to sign)
  iat: number // Issued at
  exp: number // Expiration time
  email?: string // User email (present in Google ID tokens, absent in Hydra-signed JWTs)
}

/**
 * JWKS (JSON Web Key Set) structure from Hydra
 */
export interface JWKS {
  keys: JWK[]
}

/**
 * Hydra JSON Web Key Set response
 * From Hydra admin API /admin/keys/{set}
 */
interface HydraJWKSResponse {
  keys: JWK[]
}

/**
 * Key with metadata from Hydra
 */
interface HydraKey {
  kid: string
  privateKey: CryptoKey
  publicJWK: JWK
}

/**
 * JWT Service interface
 */
export interface JWTService {
  /**
   * Sign a JWT with the given claims (Hydra mode)
   * Or return provided Google ID token (Google mode)
   */
  readonly sign: (
    claims: Omit<JWTClaims, 'iat' | 'exp' | 'kid'>,
    expiresIn: number, // Expiration in seconds
    googleIdToken?: string // Optional Google ID token (used in Google mode)
  ) => Effect.Effect<string, AppError>

  /**
   * Verify and decode a JWT
   */
  readonly verify: (token: string) => Effect.Effect<JWTClaims, AppError>

  /**
   * Generate a unique JWT ID
   */
  readonly generateJti: () => Effect.Effect<string>

  /**
   * Get JWKS (JSON Web Key Set) for public key distribution
   */
  readonly getJWKS: () => Effect.Effect<JWKS, AppError>
}

/**
 * JWT Service tag
 */
export const JWTService = Context.GenericTag<JWTService>('JWTService')

/**
 * JWT Provider type
 */
export type JWTProvider = 'hydra' | 'google'

/**
 * JWT Service configuration
 */
export interface JWTConfig {
  provider: JWTProvider // JWT signing provider ('hydra' or 'google')
  issuer: string // Token issuer (usually the application URL)
  audience: string // Token audience (usually the client application)
  hydraPublicUrl: string // Hydra public URL for JWKS endpoint
  hydraAdminUrl: string // Hydra admin URL for fetching keys
}

/**
 * Fetch signing key from Hydra admin API
 * Hydra's admin API can provide private keys for specific key sets
 */
const fetchHydraKey = async (hydraAdminUrl: string): Promise<HydraKey> => {
  try {
    // Fetch from Hydra's admin API for the JWT access token key set
    // This endpoint returns keys including private keys for signing
    const response = await axios.get<HydraJWKSResponse>(
      `${hydraAdminUrl}/admin/keys/hydra.jwt.access-token`,
      {
        headers: {
          'Content-Type': 'application/json',
        },
      }
    )

    if (!response.data?.keys || response.data.keys.length === 0) {
      throw new Error('No keys returned from Hydra')
    }

    // Use the first key (Hydra typically has one active key)
    const jwk = response.data.keys[0]

    if (!jwk.kid) {
      throw new Error('Key missing kid field')
    }

    // Import the private key from JWK
    const privateKey = await importJWK(jwk, jwk.alg || 'RS256')

    // Ensure we got a CryptoKey (not Uint8Array)
    if (!(privateKey instanceof CryptoKey)) {
      throw new Error('Expected CryptoKey from importJWK')
    }

    syncLogger.info('Fetched signing key from Hydra', {
      kid: jwk.kid,
      alg: jwk.alg,
      use: jwk.use,
    })

    return {
      kid: jwk.kid,
      privateKey,
      publicJWK: jwk,
    }
  } catch (error) {
    syncLogger.error('Failed to fetch key from Hydra', {
      hydraAdminUrl,
      error: String(error),
    })
    throw error
  }
}


/**
 * Create JWT Service implementation
 */
export const makeJWTService = (config: JWTConfig): JWTService => {
  // Only fetch keys for Hydra mode (Google mode doesn't need keys for signing)
  let keyPromise: Promise<HydraKey> | null = null
  let cachedKey: HydraKey | null = null

  const getKey = async (): Promise<HydraKey> => {
    // In Google mode, we don't sign JWTs, so we don't need signing keys
    if (config.provider === 'google') {
      throw new Error('getKey() should not be called in Google mode')
    }

    if (cachedKey) {
      return cachedKey
    }

    keyPromise ??= fetchHydraKey(config.hydraAdminUrl)

    cachedKey = await keyPromise
    syncLogger.info(`JWT service initialized with ${config.provider} key`, {
      provider: config.provider,
      kid: cachedKey.kid,
      issuer: config.issuer,
      jwksUrl: `${config.hydraPublicUrl}/.well-known/jwks.json`,
    })

    return cachedKey
  }

  // Initialize key eagerly only for Hydra mode
  if (config.provider === 'hydra') {
    getKey().catch((error) => {
      syncLogger.error(`Failed to fetch JWT key from ${config.provider}`, { error })
    })
  } else {
    syncLogger.info('JWT service initialized in Google mode', {
      provider: config.provider,
      issuer: config.issuer,
      jwksUrl: 'https://www.googleapis.com/oauth2/v3/certs',
      note: 'Will return Google ID tokens directly without signing',
    })
  }

  return {
    sign: (claims, expiresIn, googleIdToken) =>
      Effect.tryPromise({
        try: async () => {

          // Google mode: Return Google's ID token directly
          if (config.provider === 'google') {
            if (!googleIdToken) {
              throw new Error('Google ID token required when JWT_PROVIDER=google')
            }

            syncLogger.debug('Returning Google ID token', {
              sub: claims.sub,
              client_id: claims.client_id,
              jti: claims.jti,
              provider: 'google',
            })

            return googleIdToken
          }

          // Hydra mode: Sign our own JWT
          const key = await getKey()
          const now = Math.floor(Date.now() / 1000)

          const jwt = await new SignJWT({
            ...claims,
            kid: key.kid, // Include kid in claims for client validation
            iat: now,
            exp: now + expiresIn,
          })
            .setProtectedHeader({
              alg: 'RS256',
              typ: 'JWT',
              kid: key.kid, // Include kid in header for key lookup
            })
            .setIssuer(config.issuer)
            .setAudience(config.audience)
            .sign(key.privateKey)

          syncLogger.debug('JWT signed with Hydra key', {
            kid: key.kid,
            sub: claims.sub,
            client_id: claims.client_id,
            jti: claims.jti,
          })

          return jwt
        },
        catch: (error) =>
          new ParseError({
            message: `Failed to create JWT: ${String(error)} for email ${claims.email} with provider ${config.provider}`,
          }),
      }),

    verify: (token) =>
      Effect.gen(function* () {
        const claims = yield* Effect.tryPromise({
          try: async () => {
            // Use provider's public JWKS for verification
            const jwksUrl = config.provider === 'google'
              ? 'https://www.googleapis.com/oauth2/v3/certs'
              : `${config.hydraPublicUrl}/.well-known/jwks.json`

            const JWKS = createRemoteJWKSet(new URL(jwksUrl))

            const { payload } = await jwtVerify(token, JWKS, {
              issuer: config.issuer,
              audience: config.audience,
            })

            // Validate required claims
            if (!payload.sub || !payload.jti || !payload.client_id) {
              throw new Error('Missing required claims in JWT')
            }

            return payload as JWTClaims
          },
          catch: (error) =>
            new ParseError({
              message: `Failed to verify JWT: ${String(error)}`,
            }),
        })

        if (claims.email && !isEmailAllowed(claims.email)) {
          return yield* Effect.fail(new UnauthorizedEmail({ email: claims.email }))
        }

        return claims
      }),

    generateJti: () =>
      Effect.sync(() => crypto.randomBytes(16).toString('base64url')),

    getJWKS: () =>
      Effect.tryPromise({
        try: async () => {
          // Return provider's public JWKS URL for clients to use
          const jwksUrl = config.provider === 'google'
            ? 'https://www.googleapis.com/oauth2/v3/certs'
            : `${config.hydraPublicUrl}/.well-known/jwks.json`

          const response = await axios.get<JWKS>(jwksUrl)

          return response.data
        },
        catch: (error) =>
          new ParseError({
            message: `Failed to fetch JWKS from ${config.provider}: ${String(error)}`,
          }),
      }),
  }
}

/**
 * Create a Layer for JWTService
 */
export const JWTServiceLive = (config: JWTConfig) =>
  Layer.succeed(JWTService, makeJWTService(config))
