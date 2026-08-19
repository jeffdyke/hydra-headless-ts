import fs from 'fs'
import path from 'path'
import { syncLogger } from '../../logging-effect.js'

interface EmailAllowlist {
  readonly domains: ReadonlySet<string>
  readonly emails: ReadonlySet<string>
}

const loadAllowlist = (filePath: string): EmailAllowlist => {
  try {
    const content = fs.readFileSync(filePath, 'utf-8')
    const lines = content
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('#'))

    const domains = new Set<string>()
    const emails = new Set<string>()

    lines.forEach((line) => {
      if (line.includes('@')) {
        emails.add(line.toLowerCase())
      } else {
        domains.add(line.toLowerCase())
      }
    })

    syncLogger.info('Email allowlist loaded', {
      filePath,
      domainCount: domains.size,
      emailCount: emails.size,
    })

    return { domains, emails }
  } catch (error) {
    syncLogger.error('Failed to load email allowlist — all email access will be denied', {
      filePath,
      error: String(error),
    })
    return { domains: new Set(), emails: new Set() }
  }
}

const ALLOWLIST_PATH = path.resolve(
  process.env['EMAIL_ALLOWLIST_PATH'] ?? 'allowed_emails.txt'
)

// Load once at module initialization (startup)
const allowlist: EmailAllowlist = loadAllowlist(ALLOWLIST_PATH)

const matches = (list: EmailAllowlist, email: string): boolean => {
  const normalized = email.toLowerCase()

  if (list.emails.has(normalized)) return true

  const atIndex = normalized.indexOf('@')
  if (atIndex !== -1) {
    const domain = normalized.slice(atIndex + 1)
    if (list.domains.has(domain)) return true
  }

  return false
}

export const isEmailAllowed = (email: string): boolean => matches(allowlist, email)

/**
 * Per-resource allowlists.
 *
 * The global list above governs who may obtain a token at all — in practice a
 * whole domain. Some protected resources need to be narrower than that (the
 * multi-database MCP endpoint reaches production primaries, and is meant for a
 * couple of people), so each resource gets its own file alongside the global one:
 * allowed_emails_<resource>.txt, written by salt/hydra-headless-ts/init.sls.
 *
 * Deliberately strict in two ways:
 *
 *  - Membership in the resource list is required *in addition to* the global
 *    list, never instead of it. Removing someone from the global allowlist must
 *    revoke every resource.
 *  - A missing or unreadable resource file denies everyone rather than falling
 *    back to the global list. The fallback would silently widen a restricted
 *    endpoint to the entire domain the first time Salt failed to write the file,
 *    which is exactly the failure this is meant to prevent.
 */
const RESOURCE_ALLOWLIST_DIR = path.dirname(ALLOWLIST_PATH)

const resourceCache = new Map<string, EmailAllowlist | null>()

const loadResourceAllowlist = (resource: string): EmailAllowlist | null => {
  const cached = resourceCache.get(resource)
  if (cached !== undefined) return cached

  const filePath = path.join(RESOURCE_ALLOWLIST_DIR, `allowed_emails_${resource}.txt`)
  let loaded: EmailAllowlist | null
  if (fs.existsSync(filePath)) {
    loaded = loadAllowlist(filePath)
  } else {
    syncLogger.error('No allowlist for protected resource — denying all access', {
      resource,
      filePath,
    })
    loaded = null
  }

  resourceCache.set(resource, loaded)
  return loaded
}

export const isEmailAllowedForResource = (email: string, resource: string): boolean => {
  if (!isEmailAllowed(email)) return false

  const resourceList = loadResourceAllowlist(resource)
  if (resourceList === null) return false

  return matches(resourceList, email)
}
