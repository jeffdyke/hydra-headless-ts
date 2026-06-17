/**
 * Functional Google OAuth callback route using Effect
 */
import { Effect, pipe } from 'effect'
import express from 'express'
import { type AppError } from '../fp/errors.js'
import { processCallback, type GoogleOAuthClient, type CallbackConfig } from '../fp/services/callback.js'
import type { RedisService } from '../fp/services/redis.js'
import type { Layer } from 'effect';

const router = express.Router()

/**
 * Map application errors to HTTP responses
 */
const mapErrorToHttp = (error: AppError): { status: number; message: string } => {
  switch (error._tag) {
    case 'UnauthorizedEmail':
      return { status: 403, message: 'Email not authorized to access this service' }
    case 'GoogleAuthError':
      return {
        status: 400,
        message: `Google token exchange failed: ${error.errorDescription}`,
      }
    case 'RedisKeyNotFound':
      return { status: 400, message: 'Session not found or expired' }
    case 'RedisParseError':
      return { status: 500, message: 'Session data corrupted' }
    default:
      return { status: 500, message: 'Internal server error' }
  }
}

/**
 * Callback handler
 */
const createCallbackHandler = (
  serviceLayer: Layer.Layer<RedisService>,
  googleClient: GoogleOAuthClient,
  config: CallbackConfig
) => {
  return async (req: express.Request, res: express.Response) => {
    const code = req.query.code as string
    const returnedState = req.query.state as string
    const pkceKey = req.session?.pkceKey as string | undefined

    // Log entry point
    await Effect.runPromise(
      Effect.logInfo('=== CALLBACK ENDPOINT CALLED ===').pipe(
        Effect.annotateLogs({
          method: req.method,
          path: req.path,
          has_code: !!code,
          code_preview: code ? `${code.substring(0, 20)}...` : 'none',
          has_state: !!returnedState,
          state_preview: returnedState ? `${returnedState.substring(0, 20)}...` : 'none',
          has_pkce_key: !!pkceKey,
          pkce_key: pkceKey,
          session_id: req.session?.id,
          query: req.query,
          headers: {
            'content-type': req.headers['content-type'],
            'user-agent': req.headers['user-agent'],
            origin: req.headers.origin,
            referer: req.headers.referer,
          },
          ip: req.ip,
          timestamp: new Date().toISOString(),
        }),
        Effect.provide(serviceLayer)
      )
    )

    if (!code) {
      await Effect.runPromise(
        Effect.logError('=== CALLBACK ERROR: Missing Code ===').pipe(
          Effect.annotateLogs({
            query: req.query,
            timestamp: new Date().toISOString(),
          }),
          Effect.provide(serviceLayer)
        )
      )
      res.status(400).send('Missing authorization code')
      return
    }

    if (!req.session || !pkceKey) {
      await Effect.runPromise(
        Effect.logError('=== CALLBACK ERROR: Missing Session/PKCE ===').pipe(
          Effect.annotateLogs({
            has_session: !!req.session,
            has_pkce_key: !!pkceKey,
            session_id: req.session?.id,
            timestamp: new Date().toISOString(),
          }),
          Effect.provide(serviceLayer)
        )
      )
      res.status(400).send('Missing session or PKCE key')
      return
    }

    const program = pipe(
      Effect.logInfo('Processing Google OAuth callback').pipe(
        Effect.annotateLogs({
          code_preview: `${code.substring(0, 20)}...`,
          state_preview: returnedState ? `${returnedState.substring(0, 20)}...` : 'none',
          pkce_key: pkceKey,
          config,
        })
      ),
      Effect.andThen(() => processCallback(code, returnedState, pkceKey, googleClient, config)),
      Effect.provide(serviceLayer)
    )

    const result = await Effect.runPromise(Effect.either(program))

    if (result._tag === 'Left') {
      const { status, message } = mapErrorToHttp(result.left)

      await Effect.runPromise(
        Effect.logError('=== CALLBACK ERROR ===').pipe(
          Effect.annotateLogs({
            error_tag: result.left._tag,
            error_details: result.left,
            status,
            message,
            code_preview: `${code.substring(0, 20)}...`,
            timestamp: new Date().toISOString(),
          }),
          Effect.provide(serviceLayer)
        )
      )

      res.status(status).send(message)
    } else {
      await Effect.runPromise(
        Effect.logInfo('=== CALLBACK SUCCESS ===').pipe(
          Effect.annotateLogs({
            redirect_to: result.right,
            code_preview: `${code.substring(0, 20)}...`,
            timestamp: new Date().toISOString(),
          }),
          Effect.provide(serviceLayer)
        )
      )

      res.redirect(result.right)
    }
  }
}

/**
 * Create callback router with service layer
 */
export const createCallbackRouter = (
  serviceLayer: Layer.Layer<RedisService>,
  googleClient: GoogleOAuthClient,
  config: CallbackConfig
) => {
  router.get('/', createCallbackHandler(serviceLayer, googleClient, config))
  return router
}

export default router
