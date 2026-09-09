/**
 * Composes GET /.well-known/oauth-authorization-server.
 *
 * Previously this path was a blind nginx proxy straight to Hydra's own
 * /.well-known/openid-configuration (see the nginx configs under
 * build/nginx/).
 * Hydra has no notion of CIMD, so advertising support for it requires this
 * app to fetch Hydra's document itself and merge in the extra field —
 * everything else Hydra publishes (registration_endpoint, jwks_uri, etc.)
 * passes through untouched, and DCR keeps working exactly as before.
 */
import { Router } from 'express'
import { appConfig } from '../config.js'
import { syncLogger } from '../logging-effect.js'
import type { Request, Response } from 'express'

const CACHE_TTL_MS = 60_000

let cache: { body: Record<string, unknown>; expiresAt: number } | null = null

const fetchHydraDiscoveryDocument = async (): Promise<Record<string, unknown>> => {
  const url = `${appConfig.hydraInternalUrl}/.well-known/openid-configuration`
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Hydra discovery document fetch failed: HTTP ${response.status}`)
  }
  return (await response.json()) as Record<string, unknown>
}

export const createDiscoveryRouter = () => {
  const router = Router()

  router.get('/', async (_req: Request, res: Response) => {
    try {
      const now = Date.now()
      let hydraDoc: Record<string, unknown>
      if (cache && cache.expiresAt > now) {
        hydraDoc = cache.body
      } else {
        hydraDoc = await fetchHydraDiscoveryDocument()
        cache = { body: hydraDoc, expiresAt: now + CACHE_TTL_MS }
      }

      const merged = appConfig.cimd.enabled
        ? { ...hydraDoc, client_id_metadata_document_supported: true }
        : hydraDoc

      res.set('Cache-Control', 'public, max-age=60')
      res.json(merged)
    } catch (error) {
      syncLogger.error('Failed to compose oauth-authorization-server discovery document', { error })
      res.status(502).json({
        error: 'discovery_unavailable',
        error_description: 'Could not retrieve the authorization server metadata document',
      })
    }
  })

  return router
}
