
import { Effect, pipe, Schema } from 'effect'
import { OAuth2ApiService } from './api/oauth2.js'
import { appConfig, DCR_MASTER_CLIENT_ID } from './config.js';
import { HttpStatusError, type HttpError } from './fp/errors.js';
import { validateCreateClient } from "./fp/validation.js";
import type { CimdMetadata } from "./fp/domain.js";
import type { OAuth2Client as OryOAuth2Client } from "@ory/client-fetch";


export const newClient = (
  clientName: string
) => {
  const newClientIn = {
    client_name: clientName,
    grant_types: ["authorization_code", "refresh_token"],
    scope: "openid email profile offline_access",
    response_types: ["code"],
    redirect_uris: [`${appConfig.baseUrl}/callback`, "https://claude.ai/api/mcp/auth_callback"],
    token_endpoint_auth_method: "none"
  }
  return pipe(
    OAuth2ApiService,
    Effect.flatMap((api: OAuth2ApiService) => api.createClient(newClientIn))
  )
}
export const getClient = (clientId:string) =>
  pipe(
    OAuth2ApiService,
    Effect.flatMap((api) => api.getClient(clientId))
  )
export const safeGetClient = (
  clientId: string
): Effect.Effect<OryOAuth2Client, string | HttpError, OAuth2ApiService> => {
  return pipe(
    OAuth2ApiService,
    Effect.flatMap((api) => api.getClient(clientId)),
    Effect.flatMap((possibleValue) =>
      possibleValue
        ? Effect.succeed(possibleValue)
        : Effect.fail(`No Client found with id ${clientId}`)
    )
  )
}
export const listClients = () =>
  pipe(
    OAuth2ApiService,
    Effect.flatMap((api) => api.listClients())
  )

/**
 * Checks whether the configured DCR_MASTER_CLIENT_ID exists in Hydra.
 * Returns the client if found, or fails with a clear message and the new
 * client that was created so the operator can update hydra.env.
 *
 * Run this during bootstrap / deploy to detect a database-vs-config mismatch
 * before traffic starts hitting the server.
 */
export const ensureClient = (): Effect.Effect<
  OryOAuth2Client,
  string | HttpError,
  OAuth2ApiService
> => {
  const configuredId = DCR_MASTER_CLIENT_ID
  return pipe(
    OAuth2ApiService,
    Effect.flatMap((api) => api.getClient(configuredId)),
    Effect.flatMap((found) =>
      found
        ? Effect.succeed(found)
        : Effect.fail(`Client ${configuredId} not in Hydra DB — see below`)
    ),
    Effect.catchIf(
      (e) => e instanceof HttpStatusError && e.status === 404,
      () =>
        pipe(
          newClient('hydra-headless'),
          Effect.flatMap((created) =>
            Effect.fail(
              `CLIENT NOT FOUND IN HYDRA — database was likely reset.\n` +
              `New client created. Update hydra.env:\n` +
              `  AUTH_FLOW_CLIENT_ID=${created.client_id ?? '(see output)'}\n` +
              `Then restart the service.`
            )
          )
        )
    )
  )
}

/**
 * Build the Hydra admin client payload for a shadow-registered CIMD client.
 * `client_id` is set explicitly to the CIMD document's URL — unlike the
 * public DCR endpoint (which always mints its own id), Hydra's admin
 * `POST /admin/clients` accepts a caller-supplied client_id, which is what
 * makes shadow registration possible. `cimd_content_hash` is stashed in
 * Hydra's own free-form `metadata` field so change-detection survives a
 * Redis flush without an operator-visible drift between the two stores.
 */
const toHydraCimdClient = (
  clientIdUrl: string,
  metadata: CimdMetadata,
  contentHash: string
): OryOAuth2Client => ({
  client_id: clientIdUrl,
  client_name: metadata.client_name ?? clientIdUrl,
  redirect_uris: [...metadata.redirect_uris],
  grant_types: metadata.grant_types ? [...metadata.grant_types] : ['authorization_code', 'refresh_token'],
  response_types: metadata.response_types ? [...metadata.response_types] : ['code'],
  scope: metadata.scope ?? 'openid email profile offline_access',
  token_endpoint_auth_method: 'none',
  metadata: { cimd_content_hash: contentHash, cimd_fetched_at: Date.now() },
})

/**
 * Idempotently mirror a validated CIMD document into Hydra's own client
 * DB, so the existing /oauth2/auth proxy's client_id/redirect_uri
 * validation (performed by Hydra itself) passes for CIMD clients exactly
 * as it does for DCR-registered ones. A no-op when Hydra's stored
 * `cimd_content_hash` already matches the freshly computed one.
 */
export const upsertCimdClient = (
  clientIdUrl: string,
  metadata: CimdMetadata,
  contentHash: string
): Effect.Effect<OryOAuth2Client, HttpError, OAuth2ApiService> =>
  pipe(
    OAuth2ApiService,
    Effect.flatMap((api) =>
      pipe(
        api.getClient(clientIdUrl),
        Effect.flatMap((existing) => {
          const existingHash = (existing.metadata as { cimd_content_hash?: string } | undefined)
            ?.cimd_content_hash
          return existingHash === contentHash
            ? Effect.succeed(existing)
            : api.updateClient(clientIdUrl, toHydraCimdClient(clientIdUrl, metadata, contentHash))
        }),
        Effect.catchIf(
          (e) => e instanceof HttpStatusError && e.status === 404,
          () => api.createClient(toHydraCimdClient(clientIdUrl, metadata, contentHash))
        )
      )
    )
  )

//Don't need to create clients at the moment
// Creating clients needs thought into how they interact with the system
export const createClient = (clientId:string) =>
  pipe(
    listClients(),
    Effect.map((clients: OryOAuth2Client[]) =>
      clients
        .map(client => client.client_id)
        .filter((id): id is string => id !== undefined)
    ),
    Effect.flatMap((clientIds: string[]) =>
      validateCreateClient(clientId, clientIds)
    )
  )
