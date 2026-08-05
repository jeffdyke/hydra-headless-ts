import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * emailAllowlist has a module-level singleton loaded at import time.
 * We use vi.resetModules() + vi.doMock + dynamic import to get a fresh
 * instance per test with controlled file content and logging spies.
 */
describe('emailAllowlist', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    vi.resetModules()
    process.env = { ...originalEnv }
    delete process.env['EMAIL_ALLOWLIST_PATH']
  })

  afterEach(() => {
    process.env = originalEnv
  })

  /**
   * Set up mocks and dynamically load a fresh module instance.
   * Pass a string for file content or an Error to simulate a read failure.
   */
  const loadModule = async (fileContent: string | Error) => {
    const mockInfo = vi.fn()
    const mockError = vi.fn()

    vi.doMock('../../logging-effect.js', () => ({
      syncLogger: { info: mockInfo, error: mockError, debug: vi.fn(), warn: vi.fn() },
    }))

    vi.doMock('fs', () => ({
      default: {
        readFileSync: vi.fn().mockImplementation(() => {
          if (fileContent instanceof Error) throw fileContent
          return fileContent
        }),
      },
    }))

    const mod = await import('./emailAllowlist.js')
    return { isEmailAllowed: mod.isEmailAllowed, mockInfo, mockError }
  }

  // ---------------------------------------------------------------------------
  // File loading
  // ---------------------------------------------------------------------------

  describe('file loading', () => {
    it('loads domain entries and allows any email on those domains', async () => {
      const { isEmailAllowed } = await loadModule('bondlink.com\nexample.org\n')
      expect(isEmailAllowed('anyone@bondlink.com')).toBe(true)
      expect(isEmailAllowed('other@example.org')).toBe(true)
      expect(isEmailAllowed('user@gmail.com')).toBe(false)
    })

    it('loads individual email addresses', async () => {
      const { isEmailAllowed } = await loadModule('jeff@example.com\nalice@other.com\n')
      expect(isEmailAllowed('jeff@example.com')).toBe(true)
      expect(isEmailAllowed('alice@other.com')).toBe(true)
      expect(isEmailAllowed('bob@example.com')).toBe(false)
    })

    it('skips comment lines and blank lines', async () => {
      const content = `
# allowed domains
bondlink.com

# specific users
jeff@example.com
`
      const { isEmailAllowed } = await loadModule(content)
      expect(isEmailAllowed('user@bondlink.com')).toBe(true)
      expect(isEmailAllowed('jeff@example.com')).toBe(true)
    })

    it('normalises entries to lowercase at load time', async () => {
      const { isEmailAllowed } = await loadModule('BondLink.COM\nJEFF@Example.COM\n')
      expect(isEmailAllowed('user@bondlink.com')).toBe(true)
      expect(isEmailAllowed('jeff@example.com')).toBe(true)
    })

    it('logs info with domain and email counts on success', async () => {
      const { mockInfo } = await loadModule('bondlink.com\njeff@example.com\n')
      expect(mockInfo).toHaveBeenCalledWith(
        'Email allowlist loaded',
        expect.objectContaining({ domainCount: 1, emailCount: 1 })
      )
    })

    it('logs the file path on success', async () => {
      const { mockInfo } = await loadModule('bondlink.com\n')
      expect(mockInfo).toHaveBeenCalledWith(
        'Email allowlist loaded',
        expect.objectContaining({ filePath: expect.any(String) })
      )
    })

    it('returns an empty allowlist when the file is missing', async () => {
      const { isEmailAllowed } = await loadModule(
        new Error('ENOENT: no such file or directory')
      )
      expect(isEmailAllowed('admin@bondlink.com')).toBe(false)
      expect(isEmailAllowed('user@gmail.com')).toBe(false)
    })

    it('logs an error when the file fails to load', async () => {
      const { mockError } = await loadModule(
        new Error('ENOENT: no such file or directory')
      )
      expect(mockError).toHaveBeenCalledWith(
        expect.stringContaining('Failed to load email allowlist'),
        expect.objectContaining({
          error: expect.stringContaining('ENOENT'),
        })
      )
    })

    it('includes the deny-all note in the error log', async () => {
      const { mockError } = await loadModule(new Error('permission denied'))
      expect(mockError).toHaveBeenCalledWith(
        expect.stringContaining('all email access will be denied'),
        expect.any(Object)
      )
    })
  })

  // ---------------------------------------------------------------------------
  // isEmailAllowed
  // ---------------------------------------------------------------------------

  describe('isEmailAllowed', () => {
    it('allows an exact email match', async () => {
      const { isEmailAllowed } = await loadModule('allowed@example.com\n')
      expect(isEmailAllowed('allowed@example.com')).toBe(true)
    })

    it('allows any email whose domain is in the list', async () => {
      const { isEmailAllowed } = await loadModule('example.com\n')
      expect(isEmailAllowed('alice@example.com')).toBe(true)
      expect(isEmailAllowed('bob@example.com')).toBe(true)
    })

    it('rejects email whose domain is not in the list', async () => {
      const { isEmailAllowed } = await loadModule('example.com\n')
      expect(isEmailAllowed('alice@other.com')).toBe(false)
    })

    it('is case-insensitive for input', async () => {
      const { isEmailAllowed } = await loadModule('bondlink.com\njeff@example.com\n')
      expect(isEmailAllowed('User@BondLink.COM')).toBe(true)
      expect(isEmailAllowed('JEFF@EXAMPLE.COM')).toBe(true)
    })

    it('rejects input that has no @ sign', async () => {
      const { isEmailAllowed } = await loadModule('bondlink.com\n')
      expect(isEmailAllowed('notanemail')).toBe(false)
    })

    it('exact-email entry does not grant domain-wide access', async () => {
      const { isEmailAllowed } = await loadModule('jeff@bondlink.com\n')
      expect(isEmailAllowed('jeff@bondlink.com')).toBe(true)
      expect(isEmailAllowed('other@bondlink.com')).toBe(false)
    })

    it('denies all access when the allowlist failed to load', async () => {
      const { isEmailAllowed } = await loadModule(new Error('permission denied'))
      expect(isEmailAllowed('admin@bondlink.com')).toBe(false)
      expect(isEmailAllowed('root@example.com')).toBe(false)
    })

    it('does not grant access for input matching a domain name without @', async () => {
      const { isEmailAllowed } = await loadModule('bondlink.com\n')
      // 'bondlink.com' has no '@', so atIndex === -1, domain check is skipped
      expect(isEmailAllowed('bondlink.com')).toBe(false)
    })
  })

  // ---------------------------------------------------------------------------
  // Per-resource allowlists
  //
  // These gate nginx's auth_request for MCP endpoints that must be narrower than
  // the global list — which in practice is a whole domain. The two properties
  // worth protecting: a resource list only ever *narrows*, and a missing file
  // denies rather than falling back to the domain.
  // ---------------------------------------------------------------------------

  describe('per-resource allowlists', () => {
    /**
     * Resource files are resolved as allowed_emails_<resource>.txt next to the
     * global list, so the fs mock is keyed by path. `resources` maps a resource
     * name to its file content; anything absent is treated as a missing file.
     */
    const loadWithResources = async (
      globalContent: string,
      resources: Record<string, string>
    ) => {
      const mockError = vi.fn()

      vi.doMock('../../logging-effect.js', () => ({
        syncLogger: { info: vi.fn(), error: mockError, debug: vi.fn(), warn: vi.fn() },
      }))

      const pathFor = (resource: string) => `allowed_emails_${resource}.txt`
      const contentFor = (p: string): string | undefined => {
        if (!p.includes('allowed_emails_')) return globalContent
        const hit = Object.keys(resources).find((r) => p.endsWith(pathFor(r)))
        return hit === undefined ? undefined : resources[hit]
      }

      vi.doMock('fs', () => ({
        default: {
          readFileSync: vi.fn().mockImplementation((p: string) => {
            const content = contentFor(p)
            if (content === undefined) throw new Error(`ENOENT: ${p}`)
            return content
          }),
          existsSync: vi.fn().mockImplementation((p: string) => contentFor(p) !== undefined),
        },
      }))

      const mod = await import('./emailAllowlist.js')
      return { isEmailAllowedForResource: mod.isEmailAllowedForResource, mockError }
    }

    it('allows an address listed in both the global and resource lists', async () => {
      const { isEmailAllowedForResource } = await loadWithResources('bondlink.com\n', {
        'db-compare': 'justin@bondlink.com\n',
      })
      expect(isEmailAllowedForResource('justin@bondlink.com', 'db-compare')).toBe(true)
    })

    it('narrows the global list rather than replacing it', async () => {
      // The whole point: the domain grants global access, but only the named
      // address reaches the resource.
      const { isEmailAllowedForResource } = await loadWithResources('bondlink.com\n', {
        'db-compare': 'justin@bondlink.com\n',
      })
      expect(isEmailAllowedForResource('someoneelse@bondlink.com', 'db-compare')).toBe(false)
    })

    it('denies an address on the resource list but not the global list', async () => {
      // Removing someone globally must revoke every resource, even if a stale
      // resource file still names them.
      const { isEmailAllowedForResource } = await loadWithResources('bondlink.com\n', {
        'db-compare': 'contractor@elsewhere.com\n',
      })
      expect(isEmailAllowedForResource('contractor@elsewhere.com', 'db-compare')).toBe(false)
    })

    it('denies everyone when the resource file is missing', async () => {
      // Must not fall back to the global list — that would silently widen a
      // restricted endpoint to the whole domain the first time Salt failed to
      // write the file.
      const { isEmailAllowedForResource, mockError } = await loadWithResources(
        'bondlink.com\n',
        {}
      )
      expect(isEmailAllowedForResource('justin@bondlink.com', 'db-compare')).toBe(false)
      expect(mockError).toHaveBeenCalledWith(
        expect.stringContaining('No allowlist for protected resource'),
        expect.objectContaining({ resource: 'db-compare' })
      )
    })

    it('keeps resources independent of one another', async () => {
      const { isEmailAllowedForResource } = await loadWithResources('bondlink.com\n', {
        'db-compare': 'justin@bondlink.com\n',
        'other-tool': 'carl@bondlink.com\n',
      })
      expect(isEmailAllowedForResource('justin@bondlink.com', 'db-compare')).toBe(true)
      expect(isEmailAllowedForResource('justin@bondlink.com', 'other-tool')).toBe(false)
      expect(isEmailAllowedForResource('carl@bondlink.com', 'other-tool')).toBe(true)
    })

    it('supports a domain entry in a resource list', async () => {
      const { isEmailAllowedForResource } = await loadWithResources('bondlink.com\n', {
        'wide-open': 'bondlink.com\n',
      })
      expect(isEmailAllowedForResource('anyone@bondlink.com', 'wide-open')).toBe(true)
    })
  })
})
