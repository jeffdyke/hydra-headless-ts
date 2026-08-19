#!/usr/bin/env node
/**
 * Fetch a Google ID token locally, for testing the bearer gate.
 *
 * No public URL is needed. Google exempts http://localhost from its HTTPS and
 * public-hostname rules for "Web application" clients, so a loopback redirect is
 * a first-class option -- there is nothing to deploy to staging for this.
 *
 * This talks to Google DIRECTLY and never touches Hydra, which is the point:
 * routes/authz-fp.ts verifies the bearer with fp/services/jwt.ts, and in Google
 * mode that checks Google's JWKS, the issuer and the audience. None of it
 * involves Hydra, so this yields a working token even while Hydra is failing --
 * useful precisely when you are trying to test the gate and the rest of the
 * stack is not up yet.
 *
 * What it is NOT: the product's login flow. That goes through Hydra
 * (/oauth2/auth -> login -> consent -> callback) and is what you should exercise
 * before believing the whole path works. This only gets you a credential.
 *
 * The redirect URI must be registered on the Google client EXACTLY -- scheme,
 * host, port and path. Anything else is refused before you reach a consent
 * screen, with "Error 400: redirect_uri_mismatch". So by default this reuses
 * GOOGLE_REDIRECT_URI from your env, which is already registered; it does not
 * invent a port. That URI is normally your app's own callback on :8888, so free
 * the port first (nginx is on it):
 *
 *   docker compose stop nginx
 *   node scripts/dev-google-token.mjs
 *   docker compose start nginx
 *
 * Or register a second URI on the client and skip the shuffle:
 *
 *   # add http://localhost:8899/callback in the Google console, once
 *   node scripts/dev-google-token.mjs --port 8899
 *
 *   TOK=$(node scripts/dev-google-token.mjs --quiet) \
 *     && scripts/validate-mcp-path.sh --local --token "$TOK"
 *
 * Flags: --port N  --redirect URL  --env PATH  --quiet  --no-open
 */
import http from 'node:http'
import fs from 'node:fs'
import { spawn } from 'node:child_process'

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? fallback : args[i + 1]
}
const QUIET = args.includes('--quiet')
const NO_OPEN = args.includes('--no-open')
const ENV_FILE = opt('env', '/etc/hydra-headless-ts/local.env')

// stderr for everything human, so --quiet leaves stdout as just the token
const say = (...m) => { if (!QUIET) console.error(...m) }

const readEnvFile = (path) => {
  const out = {}
  if (!fs.existsSync(path)) return out
  for (const line of fs.readFileSync(path, 'utf8').split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq > 0) out[t.slice(0, eq)] = t.slice(eq + 1)
  }
  return out
}

// Process env wins, matching how the container is configured.
const fileEnv = readEnvFile(ENV_FILE)
const pick = (k) => process.env[k] || fileEnv[k]

const CLIENT_ID = pick('GOOGLE_CLIENT_ID')
const CLIENT_SECRET = pick('GOOGLE_CLIENT_SECRET')
const AUDIENCE = pick('JWT_AUDIENCE')

// Default to the redirect URI that is already registered on the client, rather
// than inventing a port. Google matches the redirect URI EXACTLY -- scheme, host,
// port and path -- so any URI not in the console's list is refused before the
// user ever sees a consent screen ("Error 400: redirect_uri_mismatch"). Reusing
// GOOGLE_REDIRECT_URI means the common case needs no console change at all.
const configured = pick('GOOGLE_REDIRECT_URI') || pick('REDIRECT_URL')
let REDIRECT
try {
  REDIRECT = new URL(opt('redirect', configured ?? 'http://localhost:8888/callback'))
} catch {
  console.error(`error: could not parse a redirect URI from --redirect / GOOGLE_REDIRECT_URI`)
  process.exit(2)
}
if (opt('port')) REDIRECT.port = opt('port')
const PORT = Number(REDIRECT.port || 80)
const CALLBACK_PATH = REDIRECT.pathname

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error(`error: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not found.`)
  console.error(`       looked in the environment and ${ENV_FILE}`)
  process.exit(2)
}

// A mismatch here is the classic symptom after recreating a Google client:
// jwt.ts verifies `aud` against JWT_AUDIENCE, so a token minted for a different
// client id is rejected with a signature-ish error that does not mention which
// field was wrong.
if (AUDIENCE && AUDIENCE !== CLIENT_ID) {
  say(`warning: JWT_AUDIENCE does not equal GOOGLE_CLIENT_ID.`)
  say(`         aud will be ${CLIENT_ID}`)
  say(`         but verify() expects ${AUDIENCE}`)
  say(`         -> /authz will reject this token. Fix ${ENV_FILE} first.\n`)
}

const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth')
authUrl.search = new URLSearchParams({
  client_id: CLIENT_ID,
  redirect_uri: REDIRECT.toString(),
  response_type: 'code',
  // openid+email are what produce an ID token carrying the `email` claim, which
  // is the identity the allowlist is keyed on.
  scope: 'openid email profile',
  access_type: 'offline',
  prompt: 'consent',
}).toString()

const exchange = async (code) => {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT.toString(),
      grant_type: 'authorization_code',
    }),
  })
  const body = await res.json()
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(body)}`)
  if (!body.id_token) throw new Error(`no id_token in response: ${JSON.stringify(body)}`)
  return body.id_token
}

const claimsOf = (jwt) => {
  try {
    return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString())
  } catch {
    return {}
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)
  if (url.pathname !== CALLBACK_PATH) {
    res.writeHead(404).end('not the callback')
    return
  }

  const err = url.searchParams.get('error')
  if (err) {
    res.writeHead(400, { 'Content-Type': 'text/plain' })
      .end(`Google returned: ${err}\nYou can close this tab.`)
    console.error(`\nerror: Google returned "${err}".`)
    if (err === 'redirect_uri_mismatch') {
      console.error(`       Add this EXACT URI to the client's authorized redirect URIs:`)
      console.error(`         ${REDIRECT}`)
    }
    server.close()
    process.exit(1)
  }

  const code = url.searchParams.get('code')
  if (!code) {
    res.writeHead(400).end('no code')
    return
  }

  try {
    const token = await exchange(code)
    const c = claimsOf(token)
    res.writeHead(200, { 'Content-Type': 'text/plain' }).end(
      `Got a token for ${c.email ?? '(no email claim)'}.\nYou can close this tab.`
    )
    say(`\nemail : ${c.email ?? '(none)'}`)
    say(`aud   : ${c.aud}`)
    say(`iss   : ${c.iss}`)
    say(`expires in ${Math.round((c.exp - Date.now() / 1000) / 60)} min\n`)
    if (!c.email) {
      say(`warning: no email claim -- /authz denies without one (403).`)
    }
    // stdout, alone, so it can be captured: TOK=$(... --quiet)
    console.log(token)
    server.close()
    process.exit(0)
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain' }).end(`exchange failed: ${e.message}`)
    console.error(`\nerror: token exchange failed: ${e.message}`)
    server.close()
    process.exit(1)
  }
})

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`error: port ${PORT} is already in use.`)
    console.error(``)
    console.error(`  ${REDIRECT} is your app's own callback, so nginx is probably on it.`)
    console.error(`  Two ways forward:`)
    console.error(``)
    console.error(`    a) free the port for a minute:`)
    console.error(`         docker compose stop nginx && node ${process.argv[1]} ; docker compose start nginx`)
    console.error(``)
    console.error(`    b) register a second redirect URI on the Google client, e.g.`)
    console.error(`         http://localhost:8899${CALLBACK_PATH}`)
    console.error(`       then re-run with:  --port 8899`)
    process.exit(2)
  }
  throw e
})

// No host argument: bind dual-stack. Binding 127.0.0.1 only looked like it
// worked while nginx held the port -- but `localhost` resolves to ::1 first, so
// the browser's callback went to nginx and this script sat waiting. Listening on
// both makes a genuine clash raise EADDRINUSE, which is handled above, instead of
// silently delivering the code to the wrong process.
server.listen(PORT, () => {
  say(`Listening on ${REDIRECT}`)
  say(`(this exact URI must be an authorized redirect URI on the client)\n`)
  say(NO_OPEN
    ? `Visit:\n\n${authUrl}\n`
    : `Opening your browser. If it does not open, visit:\n\n${authUrl}\n`)
  // macOS `open`; harmless failure elsewhere, the URL is printed above anyway.
  if (!NO_OPEN) {
    spawn('open', [authUrl.toString()], { stdio: 'ignore' }).on('error', () => {})
  }
})
