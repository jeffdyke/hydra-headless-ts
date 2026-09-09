/**
 * Proxy middleware for OAuth2 authorization flow
 * Uses RedisService from fp/services to store PKCE state with proper error handling
 */
import { type ClientRequest } from 'http'
import { Effect, Layer } from 'effect'
import express from 'express'
import { createProxyMiddleware } from 'http-proxy-middleware'
import { Redis } from 'ioredis'
import { upsertCimdClient } from '../authFlow.js'
import { appConfig } from '../config.js'
import { CimdCacheEntrySchema } from '../fp/domain.js'
import { CimdRedirectUriMismatch } from '../fp/errors.js'
import { cimdContentHash, fetchCimdMetadata, isHttpsUrlClientId } from '../fp/services/cimd.js'
import { RedisService, RedisServiceLive, createOAuthRedisOps } from '../fp/services/redis.js'
import { syncLogger } from '../logging-effect.js'
import { OAuth2ApiLayer } from './hydra.js'
import type { OAuth2ApiService } from '../api/oauth2.js'
import type { CimdMetadata, PKCEState } from '../fp/domain.js'
import type { CimdError, HttpError, SchemaValidationError } from '../fp/errors.js'
import type { Request, Response, NextFunction } from 'express'
import type { Socket } from 'net'

const app = express()
app.use(express.json())
app.use(express.urlencoded({ extended: true }))

// Create Redis client
const redisClient = new Redis({
  host: appConfig.redisHost,
  port: appConfig.redisPort,
})

// Create Redis service layer from the redis client
const redisLayer = RedisServiceLive(redisClient)

const proxyOptions = {
  target: appConfig.hydraInternalUrl,
  changeOrigin: true,
  prependPath: false,
  logger: syncLogger,
  on: {
    error: (err: Error, req: Request, res: Response | Socket) => {
      const nodeErr = err as NodeJS.ErrnoException
      syncLogger.error('Proxy error forwarding request to Hydra', {
        message: err.message,
        code: nodeErr.code,
        method: req.method,
        url: req.url,
        originalUrl: req.originalUrl,
        target: appConfig.hydraInternalUrl,
      })
      if (!('status' in res) || (res as Response).headersSent) return
      ;(res as Response).status(502).json({ error: 'proxy_error', message: 'Upstream service unavailable' })
    },
    proxyReq: (proxyReq: ClientRequest, req: Request, res: Response) => {
      const parsed = new URL(`${req.protocol  }://${  req.get('host')  }${req.originalUrl}`)
      syncLogger.info('Checking for Proxy request to Hydra', {
        method: req.method,
        originalUrl: req.originalUrl,
        proxiedUrl: `${appConfig.hydraInternalUrl}${parsed.pathname}`,
        body: req.body,
      })
      if (req.method !== "GET" && Object.keys(req.body).length > 0) {
        syncLogger.info('Populating proxy request body for non-GET request', {
          body: req.body,
          length: JSON.stringify(req.body).length,
        })
        proxyReq.path = req.originalUrl;
        proxyReq.write(JSON.stringify(req.body));
      }
      syncLogger.info('Proxy onProxyReq processing', {
        method: req.method,
        originalUrl: req.originalUrl,
        proxyPath: proxyReq.path,
      })
      // Special handling for /oauth2/register to fix contacts being null
      if (req.body && typeof req.body === 'object' && req.body?.contacts === null) {
        syncLogger.info('Modifying /oauth2/register request body to set contacts to empty array instead of null')
        // Hydra expects contacts to be an array, not null
        req.body.contacts = []
        const bodyData = JSON.stringify(req.body)
        // Update content-length header
        proxyReq.setHeader('Content-Length', Buffer.byteLength(bodyData))
        // Write modified body to proxy request
        proxyReq.write(bodyData)
        proxyReq.end()
      }
    },
  },
  pathRewrite: async (path: string, req: Request) => {
    const parsed = new URL(`${req.protocol  }://${  req.get('host')  }${req.originalUrl}`)
    if (parsed.pathname === '/oauth2/auth') {
      const sessionId = crypto.randomUUID()
      req.session.pkceKey = req.session.pkceKey ?? sessionId

      const {
        client_id,
        redirect_uri,
        state,
        code_challenge,
        code_challenge_method,
        scope,
      } = req.query

      // Only store PKCE state if we have the required parameters
      if (code_challenge !== undefined && state !== undefined) {
        const method = String(code_challenge_method ?? 'S256')
        const pkceData: PKCEState = {
          code_challenge: String(code_challenge),
          code_challenge_method: method === 'plain' ? 'plain' : 'S256',
          scope: String(scope ?? ''),
          state: String(state),
          redirect_uri: String(redirect_uri ?? ''),
          client_id: String(client_id ?? ''),
          timestamp: Date.now(),
        }

        // Store PKCE state in Redis using Effect with RedisService
        const pkceKey = req.session.pkceKey ?? sessionId
        const storePKCE = Effect.gen(function* () {
          const redis = yield* RedisService
          const redisOps = createOAuthRedisOps(redis)
          return yield* redisOps.setPKCEState(
            pkceKey,
            pkceData,
            3600 // 1 hour TTL
          )
        })

        // Provide the Redis layer and run the Effect
        const program = Effect.provide(storePKCE, redisLayer)
        const result = await Effect.runPromise(Effect.either(program))

        if (result._tag === 'Left') {
          // Log non-fatal Redis errors but don't fail the reques t
          syncLogger.error('Failed to store PKCE state in Redis', {
            key: `pkce_session:${req.session.pkceKey}`,
            error: result.left,
            pkceData,
          })
          // Continue processing - Redis failure is not fatal for the proxy
        } else {
          syncLogger.debug('PKCE state stored successfully', {
            key: `pkce_session:${req.session.pkceKey}`,
          })
        }
      }

      // Rewrite the query string
      const queryString = new URLSearchParams(parsed.searchParams.toString())
      queryString.delete('code_challenge')
      queryString.delete('code_challenge_method')
      queryString.set('state', req.session.id)

      const returnPath = [parsed.pathname, queryString].join('?')
      syncLogger.info('Proxy complete: Sending to Hydra, session ID is set to be state', {
        sessionId: req.session.id,
        pkceKey: req.session.pkceKey,
      })

      return returnPath
    }
    syncLogger.info('Proxy pathRewrite: No changes made to path', {
      parsedPath: parsed.pathname,
      body: req.body,
    })
    // Return original path if not /oauth2/auth
    return path
  },
}

/**
 * Layer providing both RedisService and OAuth2ApiService, for the CIMD
 * pipeline below (fetch/validate a remote document, then shadow-register
 * it into Hydra).
 */
const cimdLayer = Layer.merge(redisLayer, OAuth2ApiLayer)

/**
 * Describe a CIMD pipeline failure for the client-facing 400 response.
 * Intentionally terse — details go to the server log via syncLogger, not
 * to the (untrusted) requester.
 */
const describeCimdError = (error: CimdError | HttpError | SchemaValidationError): string => {
  switch (error._tag) {
    case 'CimdRedirectUriMismatch':
      return 'redirect_uri is not registered for this client'
    case 'CimdInvalidClientId':
    case 'CimdClientIdMismatch':
    case 'CimdSsrfBlocked':
    case 'CimdRedirectRejected':
    case 'CimdFetchTooLarge':
      return 'client_id metadata document could not be fetched or validated'
    default:
      return 'failed to validate client'
  }
}

/**
 * Fetch (or reuse a cached, already-validated) CIMD document for
 * `clientIdUrl`, check the request's redirect_uri against it, and — on a
 * cache miss — shadow-register the client into Hydra's own admin DB so
 * the proxied /oauth2/auth request that follows passes Hydra's native
 * client/redirect_uri validation exactly as it would for a DCR client.
 */
const runCimdPipeline = (
  clientIdUrl: string,
  redirectUri: string
): Effect.Effect<
  CimdMetadata,
  CimdError | HttpError | SchemaValidationError,
  RedisService | OAuth2ApiService
> =>
  Effect.gen(function* () {
    const redis = yield* RedisService
    const redisOps = createOAuthRedisOps(redis)

    const cached = yield* Effect.either(redisOps.getCimdMetadata(clientIdUrl, CimdCacheEntrySchema))
    if (cached._tag === 'Right') {
      const { metadata } = cached.right
      if (!metadata.redirect_uris.includes(redirectUri)) {
        return yield* Effect.fail(
          new CimdRedirectUriMismatch({ clientId: clientIdUrl, redirectUri, allowed: metadata.redirect_uris })
        )
      }
      return metadata
    }

    const metadata = yield* fetchCimdMetadata(clientIdUrl, appConfig.cimd)
    if (!metadata.redirect_uris.includes(redirectUri)) {
      return yield* Effect.fail(
        new CimdRedirectUriMismatch({ clientId: clientIdUrl, redirectUri, allowed: metadata.redirect_uris })
      )
    }

    const contentHash = cimdContentHash(metadata)
    yield* upsertCimdClient(clientIdUrl, metadata, contentHash)

    // A cache-write failure is not fatal — it only means the next request
    // re-fetches/re-upserts (a no-op against Hydra, since the content hash
    // won't have changed), same as the PKCE-state write above.
    const cacheResult = yield* Effect.either(
      redisOps.setCimdMetadata(
        clientIdUrl,
        { metadata, contentHash, fetchedAt: Date.now() },
        appConfig.cimd.cacheTtlSeconds
      )
    )
    if (cacheResult._tag === 'Left') {
      syncLogger.error('Failed to cache CIMD metadata in Redis', {
        clientIdUrl,
        error: cacheResult.left,
      })
    }

    return metadata
  })

/**
 * Enhanced proxy middleware with validation
 * Validates required OAuth2 parameters and returns 400 for fatal errors
 */
const enhancedProxyMiddleware = async (req: Request, res: Response, next: NextFunction) => {
  if (req.path === '/oauth2/auth') {
    syncLogger.info('=== OAUTH2 AUTHORIZATION ENDPOINT ===', {
      method: req.method,
      path: req.path,
      query: req.query,
      session_id: req.session.id,
      session_pkce_key: req.session.pkceKey,
      headers: {
        'content-type': req.headers['content-type'],
        'user-agent': req.headers['user-agent'],
        origin: req.headers.origin,
        referer: req.headers.referer,
      },
      ip: req.ip,
      timestamp: new Date().toISOString(),
    })

    const { client_id, redirect_uri, response_type, code_challenge, code_challenge_method, scope, state } = req.query

    // Fatal validation errors that should return 400
    const missingParams: string[] = []

    if (!client_id) missingParams.push('client_id')
    if (!redirect_uri) missingParams.push('redirect_uri')
    if (!response_type) missingParams.push('response_type')

    if (missingParams.length > 0) {
      syncLogger.error('=== OAUTH2 AUTH ERROR: Missing Parameters ===', {
        missingParams,
        query: req.query,
        timestamp: new Date().toISOString(),
      })
      return res.status(400).json({
        error: 'invalid_request',
        error_description: `Missing required parameters: ${missingParams.join(', ')}`,
      })
    }

    // Validate response_type
    if (response_type !== 'code') {
      syncLogger.error('=== OAUTH2 AUTH ERROR: Invalid Response Type ===', {
        response_type,
        query: req.query,
        timestamp: new Date().toISOString(),
      })
      return res.status(400).json({
        error: 'unsupported_response_type',
        error_description: 'Only response_type=code is supported',
      })
    }

    // CIMD (Client ID Metadata Document) clients present an https:// URL as
    // client_id instead of a Hydra-issued DCR id. Existing DCR clients fall
    // straight through unchanged — this only branches for URL-shaped ids.
    if (appConfig.cimd.enabled && isHttpsUrlClientId(String(client_id))) {
      const outcome = await Effect.runPromise(
        Effect.either(
          Effect.provide(runCimdPipeline(String(client_id), String(redirect_uri)), cimdLayer)
        )
      )
      if (outcome._tag === 'Left') {
        syncLogger.error('=== OAUTH2 AUTH ERROR: CIMD validation failed ===', {
          client_id,
          error: outcome.left,
          timestamp: new Date().toISOString(),
        })
        return res.status(400).json({
          error: 'invalid_client',
          error_description: describeCimdError(outcome.left),
        })
      }
    }

    // Log PKCE parameters
    syncLogger.info('OAUTH2 AUTH: PKCE Parameters', {
      has_code_challenge: !!code_challenge,
      code_challenge_method: code_challenge_method || 'not provided',
      has_state: !!state,
      scope,
      timestamp: new Date().toISOString(),
    })
  } else if (req.path.startsWith('/oauth2/register')) {
    syncLogger.info('=== OAUTH2 CLIENT REGISTRATION ENDPOINT ===', {
      method: req.method,
      path: req.path,
      body: req.body,
      headers: {
        'content-type': req.headers['content-type'],
        'user-agent': req.headers['user-agent'],
        origin: req.headers.origin,
      },
      ip: req.ip,
      timestamp: new Date().toISOString(),
    })
  }

  // Continue to proxy
  next()
}

// Export the middleware with validation wrapper
export default [enhancedProxyMiddleware, createProxyMiddleware(proxyOptions)]
