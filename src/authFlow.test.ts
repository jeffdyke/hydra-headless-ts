import { Effect, Layer } from 'effect'
import { describe, it, expect, vi } from 'vitest'
import { OAuth2ApiService } from './api/oauth2.js'
import { upsertCimdClient } from './authFlow.js'
import { HttpStatusError } from './fp/errors.js'
import type { CimdMetadata } from './fp/domain.js'
import type { OAuth2Client } from '@ory/client-fetch'

const metadata: CimdMetadata = {
  redirect_uris: ['https://client.example/callback'],
  client_name: 'Example MCP Client',
}

const clientIdUrl = 'https://client.example/metadata.json'
const contentHash = 'hash-1'

describe('upsertCimdClient', () => {
  it('creates a new Hydra client when none exists (404 from getClient)', async () => {
    const getClient = vi.fn(() => Effect.fail(new HttpStatusError({ status: 404, statusText: 'Not Found' })))
    const createClient = vi.fn((client: OAuth2Client) => Effect.succeed(client))
    const updateClient = vi.fn()

    const layer = Layer.succeed(OAuth2ApiService, {
      getClient,
      createClient,
      updateClient,
    } as unknown as OAuth2ApiService)

    const result = await Effect.runPromise(
      Effect.provide(upsertCimdClient(clientIdUrl, metadata, contentHash), layer)
    )

    expect(createClient).toHaveBeenCalledTimes(1)
    expect(updateClient).not.toHaveBeenCalled()
    expect(result.client_id).toBe(clientIdUrl)
    expect(result.token_endpoint_auth_method).toBe('none')
    expect((result.metadata as { cimd_content_hash?: string }).cimd_content_hash).toBe(contentHash)
  })

  it('is a no-op when the existing client already has a matching content hash', async () => {
    const existing: OAuth2Client = {
      client_id: clientIdUrl,
      metadata: { cimd_content_hash: contentHash },
    }
    const getClient = vi.fn(() => Effect.succeed(existing))
    const createClient = vi.fn()
    const updateClient = vi.fn()

    const layer = Layer.succeed(OAuth2ApiService, {
      getClient,
      createClient,
      updateClient,
    } as unknown as OAuth2ApiService)

    const result = await Effect.runPromise(
      Effect.provide(upsertCimdClient(clientIdUrl, metadata, contentHash), layer)
    )

    expect(result).toBe(existing)
    expect(createClient).not.toHaveBeenCalled()
    expect(updateClient).not.toHaveBeenCalled()
  })

  it('updates the existing client when the content hash has changed', async () => {
    const existing: OAuth2Client = {
      client_id: clientIdUrl,
      metadata: { cimd_content_hash: 'stale-hash' },
    }
    const getClient = vi.fn(() => Effect.succeed(existing))
    const createClient = vi.fn()
    const updateClient = vi.fn((_id: string, client: OAuth2Client) => Effect.succeed(client))

    const layer = Layer.succeed(OAuth2ApiService, {
      getClient,
      createClient,
      updateClient,
    } as unknown as OAuth2ApiService)

    const result = await Effect.runPromise(
      Effect.provide(upsertCimdClient(clientIdUrl, metadata, contentHash), layer)
    )

    expect(updateClient).toHaveBeenCalledTimes(1)
    expect(createClient).not.toHaveBeenCalled()
    expect((result.metadata as { cimd_content_hash?: string }).cimd_content_hash).toBe(contentHash)
  })
})
