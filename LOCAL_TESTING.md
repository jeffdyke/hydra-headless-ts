# Local Testing

How to exercise the running stack on your machine: OAuth discovery → the nginx
bearer gate → the `/authz` decision → a DBHub MCP session → a database query.

This is about the **live path**, not the unit tests. For those see
[README.test.md](README.test.md) (vitest) and [DEVELOPMENT.md](DEVELOPMENT.md).

## Why this exists

The `auth_request` gate on `/db-compare` is enforced by **nginx**, and until
recently nginx only existed on deployed hosts under Salt. So the single most
security-relevant piece of the flow could not be tested without deploying —
`validate-mcp-path.sh` used to report it as `SKIP`.

nginx now runs in `docker-compose.yml` on `http://localhost:8888`, the same entry
point and port staging uses. Dev only: staging and prod still run nginx on the
host under Salt, unchanged.

## The two scripts

| | |
|---|---|
| `scripts/validate-mcp-path.sh` | walks the live request path, stage by stage |
| `scripts/check-nginx-drift.sh` | proves the dev nginx conf still matches staging's |

Both report per-item PASS / FAIL / SKIP and exit non-zero on failure. Neither can
obtain a token or bypass authentication — stages needing a token report SKIP, and
the summary lists every skip, so a green run can't be mistaken for full coverage.

```bash
scripts/validate-mcp-path.sh --local                  # no token: stages 1-2
printf '%s' "$TOK" | scripts/validate-mcp-path.sh --local --token -   # full path
npm run check:nginx-drift
```

`--token -` reads from stdin so the token never lands in shell history or `ps`.
The token is whatever your MCP client already presents as its bearer; with
`JWT_PROVIDER=google` that's the Google ID token from a normal browser login.

## Getting the stack up

```bash
scripts/dev-bootstrap-env.sh     # copies samples into /etc/hydra-headless-ts
docker compose up -d
scripts/dev-register-client.sh   # one-time, and after any `docker compose down -v`
```

`docker compose up` treats a **missing `env_file` as fatal for the whole stack**,
not just the one service — so without `mariadb-mcp.env`, `dbhub.env` and
`dbhub.toml` nothing starts at all. That's what the bootstrap is for. It never
overwrites an existing file; it prints a diff instead, because the files it
targets hold real credentials.

Three steps stay manual, and the bootstrap prints all of them:

1. Fill `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `JWT_AUDIENCE` in
   `/etc/hydra-headless-ts/local.env`. `JWT_AUDIENCE` must equal
   `GOOGLE_CLIENT_ID` or every token is rejected on `aud`.
2. Add `http://localhost:8888/callback` as an authorized redirect URI (and
   `http://localhost:8888` as a JavaScript origin) on that Google client. Exact
   match — the port matters. Nothing in this repo can do it for you.
3. Set the database password in **both** `mariadb-mcp.env` (`DB_PASSWORD`) and
   `dbhub.env` (`DBHUB_DB_PASSWORD`) — same user, so the same value — and point
   `DB_HOST` / `dbhub.toml`'s `host =` at a database you can reach.
4. Add your address to `allowed_emails_db-compare.txt`. A **missing or empty
   per-resource list denies everyone** — it does not fall back to
   `allowed_emails.txt`. Use the `email` claim from your token, which may not be
   the account you assume: `bondlink.com`'s domain entry in the global list gets
   you past that check, but the per-resource list is individual addresses only.

## What each stage actually proves

| stage | proves |
|---|---|
| 1. discovery | nginx → Hydra works, and the `.well-known` documents mount correctly |
| 2. the gate | unauthenticated `/db-compare` is **refused**, with a challenge a client can follow |
| 3. `/authz` | the decision endpoint distinguishes no-token (401) from not-permitted (403) |
| 4. MCP session | DBHub speaks MCP and advertises its per-source tools |
| 5. query | DBHub actually reaches a configured MariaDB |

Two checks in stage 2 are worth understanding, because both catch failures that
are otherwise invisible:

- **It follows the `WWW-Authenticate` challenge**, not just asserts the header
  exists. A syntactically perfect challenge pointing at an unfetchable URL stops
  an MCP client *before* the OAuth flow starts, and the error surfaces inside the
  client where it never mentions nginx.
- **CORS preflight → 204.** This is the only cheap proof that `options_request`'s
  *relative* `include cors_headers;` resolved inside the container. A missing
  mount fails loudly at nginx start; an **empty** one fails silently and breaks
  only browser clients.

## Known state on a fresh workstation

A freshly bootstrapped workstation fails several checks before you do the manual
steps below, and none of those failures mean broken code. Once the three gaps are
closed, `--local` reports **12 passed, 0 failed, 1 skipped** — the remaining skip
is the authorized `/authz` decision, which needs a token.

**1. The local config is a staging clone.** `/etc/hydra-headless-ts/hydra.env` is
a symlink to `local.env`, which points `BASE_URL`, `HYDRA_PUBLIC_URL` and
`HYDRA_ADMIN_HOST` at `auth.staging.bondlink.org` / `10.1.1.230`; `hydra.yml`
does the same for `issuer`, `login`, `consent`, `logout`.

Consequences: `headless-ts` loops on `ensure-client` against a staging admin API
it cannot reach and **never starts serving** — which is why `/authz` returns 502
and `/db-compare` returns 500 (`auth_request` maps any non-2xx/401/403 subrequest
result to 500). Stage 1's `jwks_uri` also resolves to staging, so a "local" run
would silently be testing staging's JWKS; the script prints the resolved
`jwks_uri` so you can see that happening.

Fix: apply `build/support_files/hydra/hydra.local.yml` and
`build/support_files/hydra-headless-ts/local.env.sample`, merging your real
Google credentials in. Back up the originals first — the bootstrap deliberately
won't overwrite them.

Note `APP_ENV=local` is **not** the right value: `src/fp/config.ts` nulls the
Google credentials for it *and* forces both domains to `LOCAL_DOMAIN`, which
points the internal proxy at `localhost:4444` inside the container. Use
`development`.

**2. The database credentials are placeholders, in two files that must agree.**
Both `mariadb-mcp.env` (`DB_PASSWORD`) and `dbhub.env` (`DBHUB_DB_PASSWORD`)
connect as the same read-only user, so they need the same value. The two services
fail very differently when they're wrong, which is worth knowing before you go
hunting:

- **mariadb-mcp** builds its pool **eagerly** and `exit(1)`s if it cannot
  connect — it crash-loops and never serves. A wrong `DB_HOST` looks like
  `Can't connect to MySQL server ... Name or service not known`.
- **DBHub** is `lazy = true` in `dbhub.toml`, so it starts and answers
  `tools/list` regardless. A wrong credential surfaces only at stage 5, as
  `pool timeout: failed to retrieve a connection from pool` — which reads like an
  unreachable database but usually is not.

That laziness is deliberate: it lets stages 1–4 pass without a database and
isolates a failure to the database leg alone. The cost is that DBHub's
misconfiguration is invisible until you run a query, so check both files together.

If you have no database at all, stage 5 is the only stage that cannot pass;
everything through stage 4, including the whole gate, still runs.

**3. `redis` may collide on 6379** with another compose project (e.g.
`salt-dev-redis`). Bring services up by name if so.

## Reading a failure

| symptom | cause |
|---|---|
| `nginx exited (1)`, `host not found in upstream` | a backend is down — nginx resolves upstream names at **config load** |
| every request resets, `broken header` | `proxy_protocol` left on `listen`; there is no HAProxy locally |
| `/db-compare` → 500 | the `/_authz` subrequest failed, usually `headless-ts` not serving |
| `/db-compare` → 200 without a token | **the gate is open** — treat as serious |
| `/db-tools` → 502 | `mariadb-mcp` is down — it exits when it cannot reach the database. Contained by T9 so nginx survives |
| `/authz` → 502 | `headless-ts` not serving |
| challenge says `https://localhost` or drops `:8888` | T8 regression |
| a redirect loses the port | T4 regression — `$host` strips it, `$http_host` doesn't |
| `open() "/etc/nginx/cors_headers" failed` | a bind-mount path was wrong, so Docker created a **directory** there |
| `/authz` → 403 with a token that `validate-token` accepts | your address is not in `allowed_emails_db-compare.txt`, or the file is missing (deny-all). The token verified fine — this is authorization, not authentication |
| stage 5 pool timeout | DBHub reached, database not. Usually `DBHUB_DB_PASSWORD` still `change-me`, or disagreeing with `mariadb-mcp.env`'s `DB_PASSWORD` |

## Isolating a leg

```bash
# DBHub -> database, skipping nginx and the gate entirely
scripts/validate-mcp-path.sh --local --direct-mcp http://localhost:9002/mcp

# the pre-nginx layout (app on :3000, DBHub on :9002, gate reported SKIP)
scripts/validate-mcp-path.sh --no-nginx

# one named source; accepts execute_sql_<id> and a bare execute_sql
scripts/validate-mcp-path.sh --local --source stagingdb05
```

`--source` resolves against the tool list the server advertises rather than
constructing a name, so a typo fails immediately with the available names
instead of an opaque "unknown tool" at call time. With a **single** source DBHub
emits a bare `execute_sql` carrying no source id, so `--source` cannot be
confirmed — the script says so rather than implying it verified anything.

## Drift between dev and Salt

`build/nginx/dev/conf.d/hydra.conf` and Salt's template are two copies of the
same routing rules. `check-nginx-drift.sh` compares them **structurally** — the
set of locations, which carry `auth_request`, the `proxy_pass` path suffixes, the
upstream names, the server-scope `$mcp_resource` default — against
`build/nginx/reference/hydra.conf.staging.example`, a verbatim staging render.

Intended differences are labelled `T1`–`T9` in the dev conf's header and
normalised away. The ones that matter:

- **T4 / T8** — dev uses `$http_host` and `$scheme` where staging hardcodes
  `$host` and `https://`. Staging only gets away with it because it is https on
  443; on `:8888` those drop the port and the scheme, breaking the redirect and
  the challenge respectively.
- **T9** — `/db-tools` resolves `mariadb-mcp` at request time instead of via an
  `upstream` block. Without it, a crash-looping `mariadb-mcp` prevents nginx from
  starting at all, taking the `/db-compare` gate down with an unrelated service.
  Safe only there: it is a regex location, where `proxy_pass` with a URI passes
  it literally either way. **Do not copy it to `/db-compare`** — that is a prefix
  location, where a variable changes the rewrite semantics.

Run it after touching either side. **Refresh the reference whenever the Salt
template changes** (the scp command is in that file's header) — a stale baseline
is this check's only blind spot, which is why it prints the capture date on every
run.

One genuine dev/staging difference is *not* drift: the
`.well-known/oauth-protected-resource/*` documents here are one JSON object each,
whereas Salt's template loops all `protected_resources` into every file and emits
concatenated objects that are not valid JSON. That is a Salt bug to fix
separately.

## Ports

| port | service | note |
|---|---|---|
| 8888 | nginx | the entry point; everything should be tested through here |
| 3000 | headless-ts | bypasses the gate |
| 9001 | mariadb-mcp | bypasses the gate |
| 9002 | dbhub | bypasses the gate; needed for `--direct-mcp` |
| 4444/4445 | hydra public / admin | |

The backend ports are published for isolation testing, which also means the gate
can be bypassed from the host. Narrowing them to `127.0.0.1:` is worth doing if
that bothers you — `--direct-mcp` still works.
