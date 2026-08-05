# Local Testing

How to exercise the running stack on your machine: OAuth/JWKS discovery → a
mariadb-mcp MCP session → a database query.

This is about the **live path**, not the unit tests. For those see
[README.test.md](README.test.md) (vitest) and [DEVELOPMENT.md](DEVELOPMENT.md).

Note: `/db-tools` (mariadb-mcp) is not behind an nginx `auth_request` gate, so
there is no bearer-token leg to exercise on this path.

## Why this exists

Until recently nginx only existed on deployed hosts under Salt, so routing, CORS,
and the `.well-known` documents could not be exercised without deploying.

nginx now runs in `docker-compose.yml` on `http://localhost:8888`, the same entry
point and port staging uses. Dev only: staging and prod still run nginx on the
host under Salt, unchanged.

## The two scripts

| | |
|---|---|
| `scripts/validate-mcp-path.sh` | walks the live request path, stage by stage |
| `scripts/check-nginx-drift.sh` | proves the dev nginx conf still matches staging's |

Both report per-item PASS / FAIL / SKIP and exit non-zero on failure, and the
summary lists every skip, so a green run can't be mistaken for full coverage.

```bash
scripts/validate-mcp-path.sh --local
npm run check:nginx-drift
```

## Getting the stack up

```bash
scripts/dev-bootstrap-env.sh     # copies samples into /etc/hydra-headless-ts
docker compose up -d
scripts/dev-register-client.sh   # one-time, and after any `docker compose down -v`
```

`docker compose up` treats a **missing `env_file` as fatal for the whole stack**,
not just the one service — so without `mariadb-mcp.env` nothing starts at all.
That's what the bootstrap is for. It never overwrites an existing file; it prints
a diff instead, because the file it targets holds real credentials.

Three steps stay manual, and the bootstrap prints all of them:

1. Fill `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `JWT_AUDIENCE` in
   `/etc/hydra-headless-ts/local.env`. `JWT_AUDIENCE` must equal
   `GOOGLE_CLIENT_ID` or every token is rejected on `aud`.
2. Add `http://localhost:8888/callback` as an authorized redirect URI (and
   `http://localhost:8888` as a JavaScript origin) on that Google client. Exact
   match — the port matters. Nothing in this repo can do it for you.
3. Set `mariadb-mcp.env`'s `DB_PASSWORD` and point `DB_HOST` at a database you
   can reach.

## What each stage actually proves

| stage | proves |
|---|---|
| 1. discovery | nginx → Hydra works, and the `.well-known` documents mount correctly |
| 2. CORS preflight | `options_request`'s relative `include cors_headers;` resolved inside the container |
| 3. MCP session | mariadb-mcp speaks MCP and advertises its tools (`execute_sql`, `list_databases`, ...) |
| 4. query | mariadb-mcp actually reaches a configured MariaDB |

`/db-tools` has no `auth_request` gate, so none of this proves anything is
authenticated — only that the routing, CORS, and the MCP/DB leg work.

## Known state on a fresh workstation

A freshly bootstrapped workstation fails several checks before you do the manual
steps below, and none of those failures mean broken code.

**1. The local config is a staging clone.** `/etc/hydra-headless-ts/hydra.env` is
a symlink to `local.env`, which points `BASE_URL`, `HYDRA_PUBLIC_URL` and
`HYDRA_ADMIN_HOST` at `auth.staging.bondlink.org` / `10.1.1.230`; `hydra.yml`
does the same for `issuer`, `login`, `consent`, `logout`.

Consequences: `headless-ts` loops on `ensure-client` against a staging admin API
it cannot reach and **never starts serving**. Stage 1's `jwks_uri` also resolves
to staging, so a "local" run would silently be testing staging's JWKS; the script
prints the resolved `jwks_uri` so you can see that happening.

Fix: apply `build/support_files/hydra/hydra.local.yml` and
`build/support_files/hydra-headless-ts/local.env.sample`, merging your real
Google credentials in. Back up the originals first — the bootstrap deliberately
won't overwrite them.

Note `APP_ENV=local` is **not** the right value: `src/fp/config.ts` nulls the
Google credentials for it *and* forces both domains to `LOCAL_DOMAIN`, which
points the internal proxy at `localhost:4444` inside the container. Use
`development`.

**2. The database credential is a placeholder.** `mariadb-mcp.env`'s
`DB_PASSWORD` connects as a read-only user. mariadb-mcp builds its pool
**eagerly** and `exit(1)`s if it cannot connect — it crash-loops and never
serves, so a wrong `DB_HOST` or `DB_PASSWORD` looks like
`Can't connect to MySQL server ... Name or service not known` (or an auth error)
at startup, well before stage 3's MCP session runs.

**3. `redis` may collide on 6379** with another compose project (e.g.
`salt-dev-redis`). Bring services up by name if so.

## Reading a failure

| symptom | cause |
|---|---|
| `nginx exited (1)`, `host not found in upstream` | a backend is down — nginx resolves upstream names at **config load** |
| every request resets, `broken header` | `proxy_protocol` left on `listen`; there is no HAProxy locally |
| `/db-tools` → 502 | `mariadb-mcp` is down — it exits when it cannot reach the database. Contained by T9 so nginx survives |
| a redirect loses the port | T4 regression — `$host` strips it, `$http_host` doesn't |
| `open() "/etc/nginx/cors_headers" failed` | a bind-mount path was wrong, so Docker created a **directory** there |
| stage 4 tool error | mariadb-mcp reached, database not (or the wrong database name). Check `DB_PASSWORD`/`DB_HOST` in `mariadb-mcp.env` |

## Isolating a leg

```bash
# mariadb-mcp -> database, skipping nginx entirely
scripts/validate-mcp-path.sh --local --direct-mcp http://localhost:9001/mcp

# the pre-nginx layout (app on :3000, mariadb-mcp on :9001 directly)
scripts/validate-mcp-path.sh --no-nginx

# a named database, skipping the list_databases auto-detect
scripts/validate-mcp-path.sh --local --database BondLink
```

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
  starting at all, taking the whole proxy down with an unrelated service. Safe
  only there: it is a regex location, where `proxy_pass` with a URI passes it
  literally either way.

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
| 3000 | headless-ts | |
| 9001 | mariadb-mcp | not gated either way; needed for `--direct-mcp` |
| 4444/4445 | hydra public / admin | |

The backend ports are published for isolation testing. Narrowing them to
`127.0.0.1:` is worth doing if that bothers you — `--direct-mcp` still works.
