/**
 * Proxy middleware for OAuth2 authorization flow
 * Uses RedisService from fp/services to store PKCE state with proper error handling
 */
import { type ClientRequest } from 'http'
import { Effect } from 'effect'
import express from 'express'
import { createProxyMiddleware } from 'http-proxy-middleware'
import { Redis } from 'ioredis'
import { appConfig } from '../config.js'
import { RedisService, RedisServiceLive, createOAuthRedisOps } from '../fp/services/redis.js'
import { syncLogger } from '../logging-effect.js'
import type { PKCEState } from '../fp/domain.js'
import type { Request, Response, NextFunction } from 'express'

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
    error: (err: Error, req: Request, res: Response) => {
      const nodeErr = err as NodeJS.ErrnoException
      syncLogger.error('Proxy error forwarding request to Hydra', {
        message: err.message,
        code: nodeErr.code,
        method: req.method,
        url: req.url,
        originalUrl: req.originalUrl,
        target: appConfig.hydraInternalUrl,
      })
      if (res.headersSent) return
      res.status(502).json({ error: 'proxy_error', message: 'Upstream service unavailable' })
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
 * Enhanced proxy middleware with validation
 * Validates required OAuth2 parameters and returns 400 for fatal errors
 */
const enhancedProxyMiddleware = (req: Request, res: Response, next: NextFunction) => {
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
