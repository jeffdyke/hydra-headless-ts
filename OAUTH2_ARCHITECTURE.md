# OAuth2 Authorization Flow Architecture

## Overview

This service implements a **headless OAuth2 login/consent provider** that bridges Ory Hydra (OAuth2 server with DCR) and Google OAuth (identity provider without DCR support).

## The DCR Bridge Problem

### What is Dynamic Client Registration (DCR)?

**Dynamic Client Registration** (RFC 7591) allows OAuth2 clients to register themselves programmatically at runtime, rather than requiring manual, out-of-band registration with the authorization server.

```text
Traditional OAuth2:
Client → Manual Registration → Get client_id/secret → Use in flows

With DCR:
Client → POST /register → Receive client_id/secret → Use in flows
```

### The Incompatibility

- **Ory Hydra**: OAuth2 & OpenID Connect server that expects DCR-capable identity providers
- **Google OAuth**: Identity provider that uses traditional static client registration only

**Problem**: Hydra's architecture assumes the upstream identity provider supports DCR, but Google does not.

**Solution**: This service acts as a bridge, implementing Hydra's login/consent interface while managing static Google OAuth credentials.

## The CIMD Bridge (an alternative to DCR)

**Client ID Metadata Documents** (CIMD, draft-ietf-oauth-client-id-metadata-document) are a newer alternative to DCR: instead of a registration call, the client's `client_id` *is* an `https://` URL, and this service fetches a JSON metadata document from that URL (the same kind of fields a DCR registration would produce — `redirect_uris`, `grant_types`, etc.) instead of looking one up in a database. There is no `client_secret` — CIMD is for public clients using PKCE, exactly like this service's existing DCR-registered clients.

CIMD support is off by default (`CIMD_ENABLED`) and, when enabled, is implemented as a small pre-flight step in front of the existing `/oauth2/auth` proxy — not a parallel authorization flow. This was a deliberate choice: tracing the existing DCR bridge shows that Hydra's *only* independent contribution to this pipeline is validating `client_id`/`redirect_uri` against its own admin client DB when `/oauth2/auth` is proxied to it — login, consent, token issuance, and JWT minting are already fully local to this service and never re-validate the client against Hydra. So rather than reimplementing authorization-endpoint semantics for CIMD clients, this service **shadow-registers** them into Hydra's own client DB:

1. `setup/proxy.ts`'s `enhancedProxyMiddleware` detects an `https://`-shaped `client_id` on `/oauth2/auth` (an opaque DCR client_id falls straight through, unchanged).
2. `fp/services/cimd.ts` fetches the document at that URL and validates it against `CimdMetadataSchema` (`fp/domain.ts`). This is the SSRF-sensitive boundary of the feature, since the URL is client-supplied: only `https://`, only publicly-routable resolved addresses (checked and then *pinned* for the actual connection, closing the DNS-rebinding TOCTOU gap), no redirects followed, and hard timeout/size caps.
3. The request's `redirect_uri` is checked against the document locally (fail fast, before touching Hydra).
4. `authFlow.upsertCimdClient` idempotently mirrors the validated document into Hydra's admin client DB (`POST`/`PUT /admin/clients/{id}`, with `client_id` set explicitly to the URL — the public DCR endpoint always mints its own id, but the admin API accepts a caller-supplied one, which is what makes this possible), stamping a content hash into Hydra's own free-form `metadata` field so re-fetches are only re-applied when the remote document actually changes.
5. A short-TTL Redis cache (`fp/services/redis.ts`'s `getCimdMetadata`/`setCimdMetadata`) avoids re-fetching and re-upserting on every single authorization request.
6. Once shadow-registered, the proxied `/oauth2/auth` request continues exactly as it would for a DCR client — Hydra's own validation now passes, and login, consent, callback, and `/oauth2/token` require **zero** CIMD-specific changes, because none of them re-validate the client against Hydra today.

The `/.well-known/oauth-authorization-server` discovery document (`routes/discovery-fp.ts`) advertises `client_id_metadata_document_supported: true` when the feature is enabled; it composes Hydra's own document rather than nginx blind-proxying it, since Hydra itself has no notion of CIMD.

## Architecture Diagram

```ascii
┌─────────────────┐
│ Client App      │
│ (Claude.ai)     │
└────────┬────────┘
         │ 1. Initiate OAuth2 flow
         ↓
┌─────────────────────────────────────────┐
│ Ory Hydra (OAuth2 Server)               │
│ - Requires DCR from identity providers  │
│ - Issues: /oauth2/auth, /token, etc.    │
└────────┬────────────────────────────────┘
         │ 2. Login challenge
         ↓
┌─────────────────────────────────────────┐
│ THIS SERVICE (DCR Bridge)               │
│ ┌─────────────────────────────────────┐ │
│ │ Effect-ts Functional Layer          │ │
│ │ - Login/Consent/Logout handlers     │ │
│ │ - PKCE state management             │ │
│ │ - Redis session storage             │ │
│ │ - @kitajs/html templates            │ │
│ └─────────────────────────────────────┘ │
└────────┬────────────────────────────────┘
         │ 3. Authenticate user
         ↓
┌─────────────────────────────────────────┐
│ Google OAuth (Identity Provider)        │
│ - Static client registration only       │
│ - No DCR support                         │
└─────────────────────────────────────────┘
```

## OAuth2 Flows Supported

### 1. Authorization Code Flow with PKCE

The primary flow for web/mobile applications.

```ascii
User → Client App → Hydra /oauth2/auth
                     ↓
              Login Challenge → This Service
                     ↓
              Redirect to Google OAuth
                     ↓
              Google Authentication
                     ↓
              Google Callback → This Service
                     ↓
              Store tokens in Redis (PKCE state)
                     ↓
              Accept Hydra login → Consent Challenge
                     ↓
              User grants consent
                     ↓
              Accept Hydra consent → Auth Code
                     ↓
              Client exchanges auth code for tokens
```

**Key Files:**

- [src/views/login.tsx](src/views/login.tsx) - Login page template
- [src/views/consent.tsx](src/views/consent.tsx) - Consent page template
- [src/routes/login-fp.ts](src/routes/login-fp.ts) - Login handler
- [src/routes/consent-fp.ts](src/routes/consent-fp.ts) - Consent handler
- [src/routes/callback-fp.ts](src/routes/callback-fp.ts) - Google OAuth callback
- [src/fp/services/login.ts](src/fp/services/login.ts) - Login business logic
- [src/fp/services/consent.ts](src/fp/services/consent.ts) - Consent business logic

### 2. Device Authorization Flow (RFC 8628)

For devices with limited input capabilities (smart TVs, IoT, CLI tools).

```ascii
Device → Hydra /oauth2/device/auth
          ↓
       Device code + User code
          ↓
Device displays: "Go to https://auth.example.com/device and enter: ABCD-EFGH"
          ↓
User visits URL → This Service /device/verify
          ↓
User enters code → Validate with Hydra
          ↓
Authenticate via Google OAuth
          ↓
Device polls Hydra → Receives tokens
```

**Key Files:**

- [src/views/device/verify.tsx](src/views/device/verify.tsx) - Device code entry template
- [src/views/device/success.tsx](src/views/device/success.tsx) - Success page template
- [src/routes/device.ts](src/routes/device.ts) - Device flow handlers

### 3. Token Refresh Flow

Refreshes expired access tokens using refresh tokens.

```ascii
Client → Hydra /oauth2/token (grant_type=refresh_token)
          ↓
       Hydra validates refresh token
          ↓
       This Service refreshes Google tokens
          ↓
       Hydra issues new access token
```

**Key Files:**

- [src/fp/services/google.ts](src/fp/services/google.ts) - Google token refresh logic

### 4. Logout Flow (RP-Initiated)

Terminates OAuth2 sessions.

```ascii
Client → Hydra /oauth2/sessions/logout
          ↓
       Logout Challenge → This Service
          ↓
       User confirms logout
          ↓
       Revoke Hydra session
          ↓
       Revoke Google OAuth tokens
          ↓
       Clear cookies
```

**Key Files:**

- [src/views/logout.tsx](src/views/logout.tsx) - Logout confirmation template
- [src/routes/logout-fp.ts](src/routes/logout-fp.ts) - Logout handler
- [src/fp/services/logout.ts](src/fp/services/logout.ts) - Logout business logic

## State Management

### PKCE (Proof Key for Code Exchange)

Used to prevent authorization code interception attacks. RFC 7636.

```typescript
// Stored in Redis with TTL
interface PKCEState {
  code_challenge: string        // SHA256(code_verifier)
  code_challenge_method: 'S256'
  scope: string                 // Requested scopes
  state: string                 // OAuth2 state parameter
  redirect_uri: string          // Where to redirect after auth
  client_id: string            // Hydra client ID
  timestamp: number            // For expiration
}
```

### Session Storage (Redis)

All OAuth2 state is stored in Redis with appropriate TTLs:

- **PKCE State**: `pkce:{key}` - Expires in 10 minutes
- **Authorization Codes**: `auth_code:{code}` - Expires in 5 minutes
- **Refresh Tokens**: `refresh_token:{token}` - Expires in 30 days
- **User Sessions**: `session:{session_id}` - Configured via express-session

**Key Files:**

- [src/fp/services/redis.ts](src/fp/services/redis.ts) - Redis service with Effect
- [src/fp/domain.ts](src/fp/domain.ts) - Schema definitions for state objects

## Security Considerations

### CSRF Protection

- All forms include CSRF tokens via `csrf-csrf` middleware
- Token validation on all POST requests

### PKCE

- Code challenge/verifier pairs prevent auth code interception
- S256 (SHA-256) method used for code challenges

### State Parameter

- OAuth2 state parameter prevents CSRF in OAuth flows
- Validated on callback from Google OAuth

### Session Security

- HTTP-only cookies
- Secure flag in production
- Session stored in PostgreSQL (not in-memory)
- Configurable session TTL

### Token Storage

- Access/refresh tokens stored in Redis with encryption
- TTL-based expiration
- Tokens never exposed to client-side JavaScript

## Technology Stack

### Functional Programming (Effect-ts)

All business logic uses **Effect** for:

- **Type-safe error handling**: No exceptions, all errors typed
- **Dependency injection**: Layer-based service composition
- **Composability**: Pure functions that compose cleanly
- **Testability**: Easy mocking via Layer replacement

**Example:**

```typescript
// src/fp/services/login.ts
export const processLogin = (
  challenge: string,
  subject: string
): Effect.Effect<string, AppError, HydraService | Logger> =>
  Effect.gen(function* () {
    const hydra = yield* HydraService
    const logger = yield* Logger

    yield* logger.info('Processing login', { challenge, subject })

    const loginRequest = yield* hydra.getLoginRequest(challenge)

    if (loginRequest.skip) {
      return yield* hydra.acceptLoginRequest(challenge, { subject })
    }

    // ... more logic
  })
```

### Type Safety (@kitajs/html)

All HTML templates are type-safe TypeScript functions:

- **Compile-time validation**: Props interfaces checked by TypeScript
- **No runtime overhead**: Compiles to string concatenation
- **Refactoring support**: Rename refactoring works across templates
- **IntelliSense**: Full autocomplete for props and HTML elements

**Example:**

```typescript
// src/views/login.tsx
export interface LoginProps {
  challenge: string
  csrfToken: string
  // ... TypeScript enforces all props
}

export function Login(props: LoginProps): string {
  return Layout({ /* ... */ })
}
```

### Schema Validation (Effect Schema)

All external data validated with Effect Schema:

- **Runtime validation**: Ensures data matches expected shape
- **Type inference**: TypeScript types inferred from schemas
- **Decode/Encode**: Bidirectional transformations
- **Custom validators**: Business rules encoded in schemas

**Example:**

```typescript
// src/fp/domain.ts
export const PKCEStateSchema = Schema.Struct({
  code_challenge: Schema.String,
  code_challenge_method: Schema.Literal('S256'),
  scope: Schema.String,
  state: Schema.String,
  redirect_uri: Schema.String,
  client_id: Schema.String,
  timestamp: Schema.Number,
})

export type PKCEState = Schema.Schema.Type<typeof PKCEStateSchema>
```

### Service Layer Pattern

Services defined as Effect Context.Tag for dependency injection:

```typescript
// src/fp/services/hydra.ts
export class HydraService extends Context.Tag('HydraService')<
  HydraService,
  {
    getLoginRequest: (challenge: string) => Effect.Effect<OAuth2LoginRequest, AppError>
    acceptLoginRequest: (challenge: string, body: AcceptOAuth2LoginRequest) => Effect.Effect<string, AppError>
    // ... more methods
  }
>() {}

// src/fp/bootstrap.ts - Layer composition
export const createAppLayer = (
  redisClient: Redis,
  oauth2Config: OAuth2Config,
  logger: TsLogger,
  googleConfig: GoogleOAuthConfig
): Layer.Layer<HydraService | RedisService | Logger | GoogleOAuthService> =>
  Layer.mergeAll(
    HydraServiceLive(oauth2Config),
    RedisServiceLive(redisClient),
    LoggerServiceLive(logger),
    GoogleOAuthServiceLive(googleConfig)
  )
```

## Testing Strategy

Comprehensive test coverage with Vitest and @effect/vitest:

- **Unit Tests**: Individual service functions (101/115 passing)
- **Integration Tests**: Layer composition and service interaction
- **Schema Tests**: Runtime validation of domain types
- **Mock Layers**: Easy service mocking for isolated testing

**Example:**

```typescript
// src/fp/services/google.test.ts
describe('GoogleOAuthService', () => {
  it('should refresh token successfully', async () => {
    const mockResponse: GoogleTokenResponse = { /* ... */ }
    vi.mocked(axios.post).mockResolvedValue({ data: mockResponse })

    const program = pipe(
      googleService.refreshToken(mockTokenData),
      Effect.provide(TestServiceLayer)
    )

    const result = await Effect.runPromise(program)
    expect(result).toEqual(mockResponse)
  })
})
```

## Configuration

Environment-based configuration using Effect Config:

```typescript
// src/fp/config.ts
export const appConfigEffect = Config.all({
  environment: Config.string('APP_ENV').pipe(Config.withDefault('development')),
  baseUrl: Config.string('BASE_URL'),
  publicDomain: Config.string('PUBLIC_DOMAIN'),
  hydraPublicUrl: Config.string('HYDRA_PUBLIC_URL'),
  googleClientId: Config.string('GOOGLE_CLIENT_ID'),
  googleClientSecret: Config.string('GOOGLE_CLIENT_SECRET'),
  // ... more config
})
```

**Environment Files:**

- [src/env/local.env](src/env/local.env) - Local development
- [src/env/staging.env](src/env/staging.env) - Staging environment
- [src/env/production.env](src/env/production.env) - Production environment

## Error Handling

All errors typed using Effect's error channel:

```typescript
// src/fp/errors.ts
export class HttpStatusError extends Data.TaggedError('HttpStatusError')<{
  status: number
  statusText: string
}> {}

export class NetworkError extends Data.TaggedError('NetworkError')<{
  message: string
  cause?: unknown
}> {}

export class GoogleAuthError extends Data.TaggedError('GoogleAuthError')<{
  error: string
  errorDescription: string
}> {}

// ... more error types

export type AppError =
  | HttpStatusError
  | NetworkError
  | GoogleAuthError
  | RedisKeyNotFound
  | RedisParseError
  | SchemaValidationError
```

Errors are handled functionally using Effect.either:

```typescript
const result = await Effect.runPromise(Effect.either(program))

if (result._tag === 'Left') {
  // Handle error
  const error: AppError = result.left
} else {
  // Handle success
  const value = result.right
}
```

## Resources

### OAuth2 & OpenID Connect Specifications

- [RFC 6749](https://datatracker.ietf.org/doc/html/rfc6749) - OAuth 2.0 Authorization Framework
- [RFC 7636](https://datatracker.ietf.org/doc/html/rfc7636) - PKCE
- [RFC 7591](https://datatracker.ietf.org/doc/html/rfc7591) - Dynamic Client Registration (DCR)
- [RFC 8628](https://datatracker.ietf.org/doc/html/rfc8628) - Device Authorization Grant
- [OpenID Connect Core](https://openid.net/specs/openid-connect-core-1_0.html)

### Ory Hydra Documentation

- [Hydra Overview](https://www.ory.sh/hydra/docs/)
- [Login & Consent Flow](https://www.ory.sh/hydra/docs/concepts/login)
- [Logout Flow](https://www.ory.sh/hydra/docs/concepts/logout)

### Effect-ts Documentation

- [Effect Website](https://effect.website/)
- [Effect Schema](https://effect.website/docs/schema/introduction)
- [Effect Layers](https://effect.website/docs/guides/context-management/layers)

### Related Documentation

- [EFFECT_MIGRATION.md](EFFECT_MIGRATION.md) - fp-ts → Effect migration notes
- [TEMPLATE_MIGRATION_COMPLETE.md](TEMPLATE_MIGRATION_COMPLETE.md) - Pug → @kitajs/html migration
- [DEVELOPMENT.md](DEVELOPMENT.md) - Development guide
- [QUALITY_BASELINE.md](QUALITY_BASELINE.md) - Testing and quality infrastructure
