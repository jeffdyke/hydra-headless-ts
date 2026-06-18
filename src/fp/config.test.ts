import { Effect } from 'effect'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  appConfigEffect,
  loadAppConfigSync,
} from './config.js'

describe('fp/config', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    // Reset environment
    process.env = { ...originalEnv }
  })

  afterEach(() => {
    process.env = originalEnv
  })

  describe('appConfigEffect - development environment', () => {
    it('should load local development config with defaults', async () => {
      process.env.APP_ENV = 'development'
      process.env.BASE_URL = 'http://dev.domain.tld:3000'
      process.env.PUBLIC_DOMAIN = 'dev.domain.tld'
      process.env.PRIVATE_HOST = 'localhost'
      process.env.HYDRA_PUBLIC_URL = 'http://dev.domain.tld:4444'
      process.env.GOOGLE_CLIENT_ID = 'test-client-id'
      process.env.GOOGLE_CLIENT_SECRET = 'test-secret'

      const program = Effect.gen(function* () {
        const config = yield* appConfigEffect
        return config
      })

      const result = await Effect.runPromise(program)

      expect(result.environment).toBe('development')
      expect(result.domain.public).toBe('dev.domain.tld')
      expect(result.domain.private).toBe('localhost')
      expect(result.port).toBe(3000)
      expect(result.baseUrl).toContain('dev.domain.tld')
      expect(result.google.clientId).toBe('test-client-id')
      expect(result.google.clientSecret).toBe('test-secret')
      expect(result.security.secure).toBe(false) // Development should be insecure
    })

    it('should use http for development environment', async () => {
      process.env.APP_ENV = 'development'
      process.env.BASE_URL = 'http://dev.domain.tld:3000'
      process.env.PUBLIC_DOMAIN = 'dev.domain.tld'
      process.env.PRIVATE_HOST = 'localhost'
      process.env.HYDRA_PUBLIC_URL = 'http://dev.domain.tld:4444'

      const program = Effect.gen(function* () {
        const config = yield* appConfigEffect
        return config
      })

      const result = await Effect.runPromise(program)

      expect(result.baseUrl).toMatch(/^http:\/\//)
      expect(result.hydra.public.url).toMatch(/^http:\/\//)
    })
  })

  describe('appConfigEffect - staging environment', () => {
    it('should load staging config with https', async () => {
      process.env.APP_ENV = 'staging'
      process.env.BASE_URL = 'https://auth.staging.domain.tld'
      process.env.PUBLIC_DOMAIN = 'auth.staging.domain.tld'
      process.env.PRIVATE_HOST = '10.1.1.230'
      process.env.HYDRA_PUBLIC_URL = 'https://auth.staging.domain.tld'
      process.env.HYDRA_ADMIN_HOST = '10.1.1.230'
      process.env.HYDRA_ADMIN_PORT = '4445'
      process.env.REDIS_HOST = '10.1.1.230'
      process.env.REDIS_PORT = '16379'
      process.env.DSN = 'postgres://user:pass@host:5432/db'
      process.env.GOOGLE_CLIENT_ID = 'staging-client'
      process.env.GOOGLE_CLIENT_SECRET = 'staging-secret'

      const program = Effect.gen(function* () {
        const config = yield* appConfigEffect
        return config
      })

      const result = await Effect.runPromise(program)

      expect(result.environment).toBe('staging')
      expect(result.domain.public).toBe('auth.staging.domain.tld')
      expect(result.domain.private).toBe('10.1.1.230')
      expect(result.baseUrl).toMatch(/^https:\/\//)
      expect(result.hydra.admin.host).toBe('10.1.1.230')
      expect(result.hydra.admin.port).toBe(4445)
      expect(result.redis.host).toBe('10.1.1.230')
      expect(result.redis.port).toBe(16379)
      expect(result.security.secure).toBe(true)
    })
  })

  describe('appConfigEffect - production environment', () => {
    it('should load production config with strict security', async () => {
      process.env.APP_ENV = 'production'
      process.env.BASE_URL = 'https://auth.domain.tld'
      process.env.PUBLIC_DOMAIN = 'auth.domain.tld'
      process.env.PRIVATE_HOST = '10.0.0.100'
      process.env.HYDRA_PUBLIC_URL = 'https://auth.domain.tld'
      process.env.HYDRA_ADMIN_HOST = '10.0.0.100'
      process.env.HYDRA_ADMIN_PORT = '4445'
      process.env.REDIS_HOST = '10.0.0.101'
      process.env.REDIS_PORT = '6379'
      process.env.DSN = 'postgres://user:pass@host:5432/db'
      process.env.SESSION_SECRET = 'prod-session-secret'
      process.env.COOKIE_SECRET = 'prod-cookie-secret'

      const program = Effect.gen(function* () {
        const config = yield* appConfigEffect
        return config
      })

      const result = await Effect.runPromise(program)

      expect(result.environment).toBe('production')
      expect(result.baseUrl).toMatch(/^https:\/\//)
      expect(result.security.secure).toBe(true)
      expect(result.security.httpOnly).toBe(true)
      expect(result.security.sameSite).toBe('lax')
      expect(result.port).toBe(3000)
    })

    it('should allow optional Google OAuth credentials in production', async () => {
      process.env.APP_ENV = 'production'
      process.env.BASE_URL = 'https://auth.domain.tld'
      process.env.PUBLIC_DOMAIN = 'auth.domain.tld'
      process.env.PRIVATE_HOST = '10.0.0.100'
      process.env.HYDRA_PUBLIC_URL = 'https://auth.domain.tld'
      process.env.HYDRA_ADMIN_HOST = '10.0.0.100'
      process.env.DSN = 'postgres://user:pass@host:5432/db'
      // No GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET

      const program = Effect.gen(function* () {
        const config = yield* appConfigEffect
        return config
      })

      const result = await Effect.runPromise(program)

      expect(result.google.clientId).toBeUndefined()
      expect(result.google.clientSecret).toBeUndefined()
      expect(result.google.redirectUri).toBeDefined()
    })
  })

  describe('appConfigEffect - validation', () => {
    it('should fail when required environment variables are missing', async () => {
      process.env = {} // Clear all env vars

      const program = Effect.gen(function* () {
        const config = yield* appConfigEffect
        return config
      })

      const result = await Effect.runPromise(Effect.either(program))

      expect(result._tag).toBe('Left')
    })

    it('should handle custom port from environment', async () => {
      process.env.APP_ENV = 'development'
      process.env.BASE_URL = 'http://dev.domain.tld:4000'
      process.env.PUBLIC_DOMAIN = 'dev.domain.tld'
      process.env.PRIVATE_HOST = 'localhost'
      process.env.HYDRA_PUBLIC_URL = 'http://dev.domain.tld:4444'
      process.env.PORT = '4000'

      const program = Effect.gen(function* () {
        const config = yield* appConfigEffect
        return config
      })

      const result = await Effect.runPromise(program)

      expect(result.port).toBe(4000)
      expect(result.baseUrl).toContain(':4000')
    })

    it('should parse database DSN correctly', async () => {
      process.env.APP_ENV = 'development'
      process.env.PUBLIC_DOMAIN = 'dev.domain.tld'
      process.env.PRIVATE_HOST = 'localhost'
      process.env.HYDRA_PUBLIC_URL = 'http://dev.domain.tld:4444'
      process.env.DSN = 'postgres://testuser:testpass@dbhost:5555/testdb?sslmode=disable'

      const program = Effect.gen(function* () {
        const config = yield* appConfigEffect
        return config
      })

      const result = await Effect.runPromise(program)

      expect(result.database.dsn).toBe('postgres://testuser:testpass@dbhost:5555/testdb?sslmode=disable')
      expect(result.database.user).toBe('testuser')
      expect(result.database.password).toBe('testpass')
      expect(result.database.host).toBe('dbhost')
      expect(result.database.port).toBe(5555)
      expect(result.database.database).toBe('testdb')
    })
  })

  describe('loadAppConfigSync', () => {
    it('should synchronously load config', () => {
      process.env.APP_ENV = 'development'
      process.env.PUBLIC_DOMAIN = 'dev.domain.tld'
      process.env.PRIVATE_HOST = 'localhost'
      process.env.HYDRA_PUBLIC_URL = 'http://dev.domain.tld:4444'

      const config = loadAppConfigSync()

      expect(config.environment).toBe('development')
      expect(config.domain.public).toBe('dev.domain.tld')
    })

    it('should throw on invalid config', () => {
      process.env = {} // Clear all env vars

      expect(() => loadAppConfigSync()).toThrow()
    })
  })

  describe('DomainConfig', () => {
    it('should support separate public and private domains', async () => {
      process.env.APP_ENV = 'staging'
      process.env.BASE_URL = 'https://auth.staging.domain.tld'
      process.env.PUBLIC_DOMAIN = 'auth.staging.domain.tld'
      process.env.PRIVATE_HOST = '10.1.1.230'
      process.env.HYDRA_PUBLIC_URL = 'https://auth.staging.domain.tld'
      process.env.HYDRA_ADMIN_HOST = '10.1.1.230'
      process.env.DSN = 'postgres://user:pass@host:5432/db'

      const program = Effect.gen(function* () {
        const config = yield* appConfigEffect
        return config
      })

      const result = await Effect.runPromise(program)

      expect(result.domain.public).toBe('auth.staging.domain.tld')
      expect(result.domain.private).toBe('10.1.1.230')
      expect(result.baseUrl).toContain('auth.staging.domain.tld')
      expect(result.hydra.admin.host).toBe('10.1.1.230')
    })
  })

  describe('Environment defaults', () => {
    it('should default to local when APP_ENV is not set', async () => {
      delete process.env.APP_ENV
      process.env.PUBLIC_DOMAIN = 'dev.domain.tld'
      process.env.PRIVATE_HOST = 'localhost'
      process.env.HYDRA_PUBLIC_URL = 'http://dev.domain.tld:4444'

      const program = Effect.gen(function* () {
        const config = yield* appConfigEffect
        return config
      })

      const result = await Effect.runPromise(program)

      expect(result.environment).toBe('local')
    })
  })
})
