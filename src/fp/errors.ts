/**
 * Application error types using Effect's Data module for tagged errors
 * Each error is a discriminated union for exhaustive pattern matching
 */
import { Data } from 'effect'

/**
 * Redis operation errors
 */
export class RedisConnectionError extends Data.TaggedError('RedisConnectionError')<{
  message: string
}> {}

export class RedisKeyNotFound extends Data.TaggedError('RedisKeyNotFound')<{
  key: string
}> {}

export class RedisParseError extends Data.TaggedError('RedisParseError')<{
  key: string
  raw: string
  error: unknown
}> {}

export class RedisWriteError extends Data.TaggedError('RedisWriteError')<{
  key: string
  error: unknown
}> {}

export class RedisDeleteError extends Data.TaggedError('RedisDeleteError')<{
  key: string
  error: unknown
}> {}


export type RedisError =
  | RedisConnectionError
  | RedisKeyNotFound
  | RedisParseError
  | RedisWriteError
  | RedisDeleteError

/**
 * HTTP client errors
 */
export class NetworkError extends Data.TaggedError('NetworkError')<{
  message: string
  cause?: unknown
}> {}

export class HttpStatusError extends Data.TaggedError('HttpStatusError')<{
  status: number
  statusText: string
  body?: unknown
}> {}

export class TimeoutError extends Data.TaggedError('TimeoutError')<{
  timeoutMs: number
}> {}

export class ParseError extends Data.TaggedError('ParseError')<{
  message: string
  raw?: string
}> {}

export type HttpError = NetworkError | HttpStatusError | TimeoutError | ParseError

/**
 * CIMD (Client ID Metadata Document) fetch/validation errors
 */
export class CimdInvalidClientId extends Data.TaggedError('CimdInvalidClientId')<{
  clientId: string
  reason: string
}> {}

export class CimdSsrfBlocked extends Data.TaggedError('CimdSsrfBlocked')<{
  clientId: string
  host: string
  reason: string
}> {}

export class CimdFetchTooLarge extends Data.TaggedError('CimdFetchTooLarge')<{
  clientId: string
  maxBytes: number
}> {}

export class CimdRedirectRejected extends Data.TaggedError('CimdRedirectRejected')<{
  clientId: string
  status: number
  location: string | null
}> {}

export class CimdClientIdMismatch extends Data.TaggedError('CimdClientIdMismatch')<{
  clientId: string
  documentClientId: string
}> {}

export class CimdRedirectUriMismatch extends Data.TaggedError('CimdRedirectUriMismatch')<{
  clientId: string
  redirectUri: string
  allowed: readonly string[]
}> {}

export type CimdError =
  | CimdInvalidClientId
  | CimdSsrfBlocked
  | CimdFetchTooLarge
  | CimdRedirectRejected
  | CimdClientIdMismatch
  | CimdRedirectUriMismatch

/**
 * OAuth2/PKCE validation errors
 */
export class InvalidPKCE extends Data.TaggedError('InvalidPKCE')<{
  challenge: string
  verifier: string
  method: string
}> {}

export class InvalidGrant extends Data.TaggedError('InvalidGrant')<{
  reason: string
}> {}

export class InvalidScope extends Data.TaggedError('InvalidScope')<{
  requested: string[]
  granted: string[]
}> {}

export class InvalidClient extends Data.TaggedError('InvalidClient')<{
  clientId: string
}> {}

export class MissingParameter extends Data.TaggedError('MissingParameter')<{
  parameter: string
}> {}

export class ExpiredToken extends Data.TaggedError('ExpiredToken')<{
  tokenType: 'auth_code' | 'refresh_token'
}> {}

export class UnauthorizedEmail extends Data.TaggedError('UnauthorizedEmail')<{
  email: string
}> {}

export type OAuthError =
  | InvalidPKCE
  | InvalidGrant
  | InvalidScope
  | InvalidClient
  | MissingParameter
  | ExpiredToken
  | UnauthorizedEmail

/**
 * Google OAuth errors
 */
export class GoogleAuthError extends Data.TaggedError('GoogleAuthError')<{
  error: string
  errorDescription?: string
}> {}

export class GoogleTokenExpired extends Data.TaggedError('GoogleTokenExpired')<{
  refreshToken: string
}> {}

export class GoogleTokenRevoked extends Data.TaggedError('GoogleTokenRevoked')<{
  refreshToken: string
}> {}

export type GoogleOAuthError = GoogleAuthError | GoogleTokenExpired | GoogleTokenRevoked

/**
 * Session errors
 */
export class SessionNotFound extends Data.TaggedError('SessionNotFound')<{
  sessionId: string
}> {}

export class SessionExpired extends Data.TaggedError('SessionExpired')<{
  sessionId: string
}> {}

export class SessionStorageError extends Data.TaggedError('SessionStorageError')<{
  error: unknown
}> {}

export type SessionError = SessionNotFound | SessionExpired | SessionStorageError

/**
 * Validation errors
 */
export class SchemaValidationError extends Data.TaggedError('SchemaValidationError')<{
  errors: string[]
  value: unknown
}> {}

export class RequiredFieldMissing extends Data.TaggedError('RequiredFieldMissing')<{
  field: string
}> {}

export class InvalidFormat extends Data.TaggedError('InvalidFormat')<{
  field: string
  expected: string
  received: unknown
}> {}
export class ClientExistsError extends Data.TaggedError("ClientExists")<{
  clientId: string
  clients: string[]

}> {}
export class ClientNotFound extends Data.TaggedError("ClientExists")<{
  clientId: string
}> {}
export type ValidationError =
  | SchemaValidationError
  | RequiredFieldMissing
  | InvalidFormat
  | ClientExistsError
  | ClientNotFound

/**
 * Application-level errors (union of all domain errors)
 */
export type AppError =
  | RedisError
  | HttpError
  | OAuthError
  | GoogleOAuthError
  | SessionError
  | ValidationError
  | CimdError
