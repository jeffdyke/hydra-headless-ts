# Staging troubleshooting notes

Symptom-first catalogue of issues hit while standing up the multi-database
mariadb-mcp deployment and the Claude OAuth connector against staging. Most of
these were operator error rather than code bugs — noted here so the same
mistake doesn't cost another debugging session.

## Docker Compose

- **`docker-compose -f docker-compose.mariadb-mcp.<env>.yml up` fails with
  `refers to undefined network hydra-net`.** Always pass both files:
  `-f docker-compose.yml -f docker-compose.mariadb-mcp.<env>.yml`. The
  `mariadb-mcp-base` anchor, the `hydra-net` network, and the `hydra` project
  name only exist in `docker-compose.yml`; `extends:` pulls in the referenced
  service but not the base file's top-level `networks:`/`name:`.

- **Edited `env_file` contents don't take effect.** `docker compose restart`
  reuses the existing container's already-baked environment; it does not
  re-read `env_file:`. Use `docker compose up -d --force-recreate --no-deps
  <service>` instead. This applies just as hard to a container that's
  currently crash-looping on its own (`restart: unless-stopped`): waiting for
  the automatic restart to pick up a fix does nothing — it's still restarting
  with whatever env was baked in at last `up`. On staging/prod, remember
  `env_file` (`/etc/hydra-headless-ts/hydra.env`) is itself rendered by Salt
  from pillar — an edit isn't even "on disk" until someone runs, on the
  target env's salt master, `cd /src/salt && blgit pull` (or checks out the
  branch with the edit) then `sudo salt <minion> state.sls hydra-headless-ts`.
  So there are two separate propagation steps to verify, not one: pillar →
  rendered `hydra.env`, then rendered `hydra.env` → running container.

- **A container that should be gone is still running after regenerating a
  compose file.** If a service was renamed/removed (e.g.
  `mariadb-mcp-stagingdb01` → bare `mariadb-mcp`), Compose only manages what's
  currently in the file — it won't stop the orphan on its own. Add
  `--remove-orphans` to the `up`.

- **New/renamed service fails to start entirely, taking the whole `up` down
  with it.** A missing `env_file` path is fatal for the *entire* `docker
  compose up`, not just that one service. Confirm the file exists at the exact
  path the new service name expects before recreating.

- **A bare `docker compose <cmd>` on a deployed host silently talks to the
  wrong project.** Staging/prod run project `hydra-mcp` via two `-f` files
  (`docker-compose.yml` + `/etc/hydra-headless-ts/docker-compose.mariadb-mcp.
  <env>.yml`), managed by `/etc/init.d/hydra-mcp` — not project `hydra` from
  `docker-compose.yml`'s own `name:`. Always pass both `-f` files and
  `-p hydra-mcp` explicitly. Scripts under `scripts/` and `build/` source
  `scripts/compose-env.sh`, which auto-detects this (deployed host vs. local
  dev checkout) and exports `COMPOSE_ARGS`/`DOCKER_CMD`/`compose()` — source
  it instead of re-deriving the flags in any new script. It does not help
  ad-hoc commands typed by hand; those still need the flags spelled out (see
  the diagnostic commands throughout this doc for the exact invocation).

## OAuth client configuration (Hydra + Google)

- **Two unrelated "client" concepts, easy to conflate:** `AUTH_FLOW_CLIENT_ID`
  (a Hydra OAuth2 client — identifies claude.ai/inspector to *this app's*
  Hydra) and `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` (identifies this app to
  Google, for end-user login). They don't reference each other. The Claude
  connector's "client ID" field wants `AUTH_FLOW_CLIENT_ID`.

- **A registration helper's printed instructions don't match where the app
  actually reads config.** `scripts/dev-register-client.sh` now detects this
  and prints the right target: on a deployed host, `AUTH_FLOW_CLIENT_ID` in
  `hydra.env` comes from Salt pillar (`pillar/<env>/oauth/init.sls`'s
  `dcr_client_id`, rendered by `env.tmpl.jinja2`), not any local file —
  registering a new client means updating that pillar key and applying it
  (see the `env_file` bullet above for the apply steps), not editing
  `/etc/hydra-headless-ts/local.env` (dev-only, and inert on staging/prod).
  Same trap for the CLI: plain `npm run cli` hardcodes
  `--env-file=./src/env/local.env`; use `cli:env` (no override, relies on real
  process env) when operating against staging/prod.

- **Registering a client with `npm run cli -- new-client` fails silently /
  wrong redirect list.** The subcommand is `new-client "<name>"` (not `new`)
  and requires the name argument. Its default redirect_uris come from
  `src/authFlow.ts`'s hardcoded list — verify against `AUTH_FLOW.md`'s
  documented `https://claude.ai/api/mcp/auth_callback` before trusting it.

- **"Unknown client" / login fails after registering a new client.** Don't
  assume — check what's actually live:
  `docker exec <container> env | grep AUTH_FLOW_CLIENT_ID`, then confirm that
  ID exists via `npm run cli:env -- list-clients`. A mismatch here usually
  means the env file was edited but the container was only `restart`ed, not
  recreated (see Compose section above).

- **`Google token exchange failed: Error: invalid_grant` after consent
  succeeds.** Not a scope issue (`access_type=offline` + `prompt=consent` are
  what actually earn a refresh token, not a scope string). Getting past the
  Google consent screen only proves `client_id` + `redirect_uri` are valid —
  the token exchange is the first step that also checks `client_secret`. Check
  for a mismatched client_id/client_secret pair (e.g. after rotating to a new
  Google OAuth client and only updating one of the two).

- **A CLI/node command errors with `node: bad option: --env-file=...`.**
  `--env-file` needs Node ≥20.6; the container image (`node:22-alpine`)
  supports it fine. This error means the command ran against a different,
  older Node — almost always the bare host's system Node rather than inside
  the container. Run CLI commands via `docker exec`/`docker compose exec`.

- **`hydra list clients` shows a huge number of near-identical clients.**
  This is crash-loop damage — see `AUTH_FLOW.md`'s `ensureClient` note: every
  restart with a bad `AUTH_FLOW_CLIENT_ID` mints one more. They all match the
  same exact shape: `grant_types: authorization_code,refresh_token`;
  `response_types: code`; `redirect_uris:
  https://oauth.<env>.bondlink.org/callback, https://claude.ai/api/mcp/auth_callback`;
  `client_name: hydra-headless`. Cleanup: paginate `hydra list clients`
  (`IS LAST PAGE` in the output tells you when to stop) and delete every
  client matching that exact shape, carefully excluding the currently
  configured `AUTH_FLOW_CLIENT_ID` and any other intentionally-registered
  client.

## nginx / HAProxy

- **A config value was fixed on disk but the old behavior persists.** Both
  nginx and Hydra only pick up config changes on their own reload/restart —
  editing `/etc/nginx/conf.d/hydra.conf` does nothing until `nginx -s reload`.
  Compare the file's mtime against the process's last reload/start time before
  assuming a fix didn't work.

- **HAProxy vs nginx confusion when chasing a routing/redirect bug.** HAProxy
  only does flat path-prefix ACL routing to a single backend (`/db-tools`,
  `/mcp` → one backend); it has no per-mariadb-mcp-instance knowledge. The
  per-instance `upstream`/`location`/`auth_request` logic lives in the
  Salt-templated host nginx config, not HAProxy.

## mariadb-mcp instances

- **MCP resource returns an error only *after* a successful OAuth
  handshake.** Authentication succeeding (200 from `/oauth2/token`) says
  nothing about whether the requested `resource`'s backend actually exists.
  Check `docker ps` for a container actually publishing the port nginx expects
  for that resource.

- **Bare `/db-tools` (the default instance) has no backend.** Confirm the
  compose file for the environment actually defines a bare `mariadb-mcp`
  service (port `9001:9001`), not just the named instances. This is generated
  by `ci/generate_mariadb_mcp_compose.py` in the salt repo from
  `mcp_auth_db`/`mcp_default_db` pillar flags — regenerate and diff if a
  default is missing. Even when the file does define it, a scoped
  `up -d <service>` (e.g. recreating just `headless-ts` to pick up an env
  change) won't start it — Compose only touches the service(s) you name, it
  never reconciles the rest of the project. Don't rely on a single-service
  recreate command surviving in shell history for next time; the safe,
  reproducible recovery command is the full-stack recreate (all `-f` files,
  no service name, so it starts/recreates everything the project defines and
  removes anything stale):
  ```
  sudo docker compose -f /src/hydra-headless-ts/docker-compose.yml -f /etc/hydra-headless-ts/docker-compose.mariadb-mcp.<env>.yml -p hydra-mcp up -d --remove-orphans
  ```
  Confirm with `ps` afterward that a bare `mariadb-mcp-<env>` (or similar)
  container is listed alongside the named `mariadb-mcp-<name>` instances, not
  just the named ones.

- **Claude connector lists no tools / picks the wrong instance.** Configure
  the connector with exactly one resource URL
  (`https://oauth.staging.bondlink.org/db-tools`, or a specific
  `/db-tools/<name>` for a named instance) — don't leave both a bare and a
  named entry configured at once.
