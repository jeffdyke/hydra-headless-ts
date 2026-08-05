/**
 * Authorization endpoint for nginx's auth_request.
 *
 * The MCP backend behind this proxy — mariadb-mcp — does not validate bearer
 * tokens itself. Without this endpoint the OAuth flow only gates
 * *obtaining* a token; anything that could reach the backend port could use the
 * MCP tools without presenting one. nginx calls here before proxying (see the
 * /_authz location in salt/hydra-headless-ts/etc/nginx/conf.d/hydra.conf).
 *
 * Contract expected by auth_request: 2xx allows the request, 401/403 denies it,
 * and anything else becomes a 500. So every path below returns one of those three
 * deliberately, and the body is never used — nginx discards it.
 *
 * 401 vs 403 matters to the caller: nginx turns a 401 into the WWW-Authenticate
 * challenge that tells an MCP client where to authenticate, so 401 means "no
 * usable token, go get one" and 403 means "your token is fine, you are not
 * permitted here" — a challenge would just loop the client.
 */
import { Router } from 'express'
import { Effect, Layer } from 'effect'
import { JWTService } from '../fp/services/jwt.js'
import { isEmailAllowedForResource } from '../fp/services/emailAllowlist.js'
import { syncLogger } from '../logging-effect.js'
import type { Request, Response } from 'express'

export const createAuthzRouter = (serviceLayer: Layer.Layer<any>) => {
  const router = Router()

  // `all`, not `get`: nginx issues the auth subrequest with the original method.
  router.all('/', async (req: Request, res: Response) => {
    const resource = (req.headers['x-mcp-resource'] as string | undefined)?.trim()
    const originalUri = (req.headers['x-original-uri'] as string | undefined) ?? ''

    // nginx always sets X-MCP-Resource for a gated location. Its absence means
    // the nginx config and this endpoint disagree, so refuse rather than guess
    // which allowlist to apply.
    if (!resource) {
      syncLogger.error('authz called without X-MCP-Resource — denying', { originalUri })
      return res.status(403).end()
    }

    const authHeader = req.headers.authorization
    if (!authHeader?.startsWith('Bearer ')) {
      syncLogger.info('authz denied: no bearer token', { resource, originalUri })
      return res.status(401).end()
    }
    const token = authHeader.substring(7)

    let email: string | undefined
    try {
      const claims = await Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            const jwt = yield* JWTService
            return yield* jwt.verify(token)
          }),
          serviceLayer
        )
      )
      email = claims.email
    } catch (error) {
      // Covers an invalid signature, an expired token, and a subject the global
      // allowlist rejects — all "get a new token", so all 401.
      syncLogger.info('authz denied: token verification failed', {
        resource,
        error: String(error),
      })
      return res.status(401).end()
    }

    // With JWT_PROVIDER=google the access token is Google's ID token, which
    // carries email. Under JWT_PROVIDER=hydra it would not unless the claim is
    // added where the token is signed — deny rather than fall open.
    if (!email) {
      syncLogger.error('authz denied: verified token carries no email claim', { resource })
      return res.status(403).end()
    }

    if (!isEmailAllowedForResource(email, resource)) {
      syncLogger.info('authz denied: not on the resource allowlist', { resource, email })
      return res.status(403).end()
    }

    syncLogger.info('authz allowed', { resource, email })
    return res.status(204).end()
  })

  return router
}
