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

export const isEmailAllowed = (email: string): boolean => {
  const normalized = email.toLowerCase()

  if (allowlist.emails.has(normalized)) return true

  const atIndex = normalized.indexOf('@')
  if (atIndex !== -1) {
    const domain = normalized.slice(atIndex + 1)
    if (allowlist.domains.has(domain)) return true
  }

  return false
}
