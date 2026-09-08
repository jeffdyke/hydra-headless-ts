# hydra-headless-ts prod OAuth client incident — RESOLVED (2026-09-08)

Incident record for the prod crash-loop / OAuth client mess-up on
`prodops03` on 2026-09-08. Originally started as an uncommitted recovery note
in case the Claude Code session was lost mid-incident; kept and committed here
now that it's resolved, as the chronology behind the doc updates listed below.

## Resolution

`headless-ts` was recreated (`docker compose ... up -d headless-ts`, not just
`restart`) so it finally picked up the current `hydra.env`
(`AUTH_FLOW_CLIENT_ID=312dd3d7-61db-4a62-a182-c6c13fb8337b`,
`SKIP_CLIENT_CHECK=1`) instead of whatever was baked in ~30 hours earlier.
Confirmed stable and authenticating successfully from claude.ai.

One follow-on gap found during recovery: the bare `mariadb-mcp` (default
`/db-tools`) instance hadn't come up — recreating just `headless-ts` doesn't
touch other services. Fixed with a full-stack recreate
(`up -d --remove-orphans`, no service name) rather than a one-off targeted
command. All of this session's durable findings were written into the repo's
docs rather than left here — see below.

## Docs/skills updated this session (durable, committed home for these learnings)

- `AUTH_FLOW.md` — new "Startup client verification (`ensureClient`)" section:
  documents that a failed client check mints a throwaway Hydra client before
  exiting 1, which is what turns a stale `AUTH_FLOW_CLIENT_ID` into a
  client-minting crash loop.
- `STAGING_TROUBLESHOOTING.md` — extended the `env_file`-doesn't-reload bullet
  with the Salt pillar propagation layer; extended the registration-helper
  bullet with the pillar `dcr_client_id` path; added a bulk-cleanup recipe for
  orphaned throwaway clients; added a bullet on bare `docker compose` resolving
  to the wrong project on deployed hosts; extended the bare `/db-tools` bullet
  with the full-stack recreate command (see mariadb-mcp gap above).
- `DEVELOPMENT.md` — follow-up TODO note on the inert
  `NODE_ENV='--env-file=...'` string in `serve:staging`/`serve:production`
  (confirmed harmless — compose's own `env_file:` already does the real
  injection — but confusing to read and worth a small cleanup PR).
- `.claude/skills/session-debrief/SKILL.md` — new skill (didn't exist in this
  repo yet), adapted from `/src/infrastructure` and `/src/salt`'s versions,
  pointed at this repo's doc-file-centric convention (no `CLAUDE.md` here).

## Still open / not done this session

- **Bulk-cleanup of orphaned throwaway Hydra clients** — `hydra list clients`
  still shows many auto-created clients from the crash-loop period (see
  `STAGING_TROUBLESHOOTING.md`'s cleanup bullet for the exact shape to match
  and exclude). Not yet attempted.
- PR #11 (`fix-hydra-mcp-compose-detection` → `RC`) still open; the doc edits
  above are uncommitted working-tree changes on that branch as of this note.

## Branch / PR (already pushed, safe regardless of this session)

- Branch: `fix-hydra-mcp-compose-detection`, based off `RC`.
- PR: [mblink/hydra-headless-ts#11](https://github.com/mblink/hydra-headless-ts/pull/11)
- Commits so far:
  - `f022a96` — new `scripts/compose-env.sh` (auto-detects deployed host,
    managed by `/etc/init.d/hydra-mcp`, vs. local dev checkout; exports
    `COMPOSE_ARGS`/`DOCKER_CMD`/`compose()`). Fixed `scripts/dev-register-client.sh`,
    `scripts/dump_postgres.sh`, `scripts/load_postgres.sh`, `build/rebuild.sh`,
    `build/shared.sh` to stop assuming a bare `docker compose` resolves to the
    right project (it doesn't — deployed host runs project `hydra-mcp` via two
    `-f` files, not project `hydra` from `docker-compose.yml`'s own `name:`).
  - `6af2b1e` — made `dev-register-client.sh`'s `BASE_URL` default and its
    post-registration instructions environment-aware: on a deployed host,
    `BASE_URL` is now read from the host's own rendered `/etc/hydra-headless-ts/hydra.env`
    instead of defaulting to `localhost:8888`, and the final instructions point
    at updating salt pillar (`pillar/<env>/oauth/init.sls`'s `dcr_client_id`)
    instead of the local-dev-only `local.env` file.

## Root cause chain uncovered this session

1. Scripts assumed a single default `docker compose` project/file lookup;
   deployed hosts actually run two `-f` files + project `hydra-mcp` via
   `/etc/init.d/hydra-mcp` (rendered by `/src/salt/salt/hydra-headless-ts/init.sls`).
   Fixed (see commits above).
2. `dev-register-client.sh` told the user to edit `/etc/hydra-headless-ts/local.env`.
   On a deployed host that file does nothing — `/etc/hydra-headless-ts/hydra.env`
   is rendered by Salt from `env.tmpl.jinja2`, and
   `AUTH_FLOW_CLIENT_ID={{ google_oauth["dcr_client_id"] }}` comes from pillar:
   `/src/salt/pillar/prod/oauth/init.sls` (`dcr_client_id: ...`),
   `/src/salt/pillar/staging/oauth/init.sls`, `/src/salt/pillar/base/oauth/init.sls`.
   Fixed in the script (commit `6af2b1e`); pillar itself must still be updated +
   applied by hand each time a client is (re)registered.
3. `src/authFlow.ts`'s `ensureClient()` (invoked by `build/entrypoint.sh` via
   `npm run cli:env -- ensure-client` on every container start) does NOT just
   fail when the configured client is missing — it calls Hydra's admin API and
   creates a brand-new throwaway client (`newClient('hydra-headless')`) *before*
   failing with exit 1. Combined with `restart: unless-stopped` on `headless-ts`,
   a stale `AUTH_FLOW_CLIENT_ID` causes a crash loop that mints a new orphaned
   OAuth2 client roughly every ~11s, indefinitely.
4. Editing pillar + `git push` alone does NOT change anything on the running
   host. Salt's fileserver is plain `roots` (not gitfs) — pillar/state content
   only updates when someone runs, on the target env's **salt master**
   (`prodsalt-arm` for prod, per `/src/salt/CLAUDE.md`):
   `cd /src/salt && blgit pull` (or checkout the branch with the edit), then
   `sudo salt <minion> state.sls hydra-headless-ts`. Restarting the container
   only reloads whatever is *already* on disk in `hydra.env` — it does not
   re-render it.

## Where things stand right now (as of last message)

- `/etc/hydra-headless-ts/hydra.env` on `prodops03` now correctly shows:
  `AUTH_FLOW_CLIENT_ID=312dd3d7-61db-4a62-a182-c6c13fb8337b`
  — confirms the pillar update + salt apply finally landed correctly this time.
- **`hydra list clients` on prod shows a huge number (multiple pages, `IS LAST
  PAGE: false`) of near-identical auto-created throwaway clients** — exact shape
  matches `ensureClient`'s fallback (`grant_types: authorization_code,
  refresh_token`; `response_types: code`; `redirect_uris:
  https://oauth.prod.bondlink.org/callback, https://claude.ai/api/mcp/auth_callback`;
  client_name `hydra-headless`). This is crash-loop damage from root cause #3 —
  needs a bulk-cleanup pass **after** the current issue is resolved. Not yet
  attempted; would need to paginate `hydra list clients` and delete every match
  on that exact shape, carefully excluding `312dd3d7-...` and any other
  intentionally-registered client.
- User set `SKIP_CLIENT_CHECK=1` as a stopgap to stop the crash loop. Reported
  symptom now: **app is up but the browser gets an OAuth redirect loop** on
  login — a different, not-yet-diagnosed problem from the crash loop.
- Diagnostics requested from user, **not yet returned**:
  1. `sudo cat /etc/hydra-headless-ts/hydra.env | grep SKIP_CLIENT_CHECK`
     (confirm it's actually in the right file, not `local.env` again)
  2. `sudo docker compose -f /src/hydra-headless-ts/docker-compose.yml -f /etc/hydra-headless-ts/docker-compose.mariadb-mcp.prod.yml -p hydra-mcp ps`
     (confirm all 4 services Up, not restarting)
  3. `sudo docker compose -f /src/hydra-headless-ts/docker-compose.yml -f /etc/hydra-headless-ts/docker-compose.mariadb-mcp.prod.yml -p hydra-mcp exec -T hydra hydra get client 312dd3d7-61db-4a62-a182-c6c13fb8337b --endpoint http://127.0.0.1:4445 --format json`
     (confirm the configured client is real/well-formed)
  4. `sudo docker compose -f /src/hydra-headless-ts/docker-compose.yml -f /etc/hydra-headless-ts/docker-compose.mariadb-mcp.prod.yml -p hydra-mcp logs --tail=200 -f headless-ts`
     tailed while reproducing the redirect loop in a browser (devtools Network
     tab open, disable cache) to see the actual bounced URLs/status codes.

## Key facts to hand a fresh session if this one is lost

- Repo: `/Volumes/Sources/hydra-headless-ts` (local checkout, macOS). Target
  host: `prodops03` (SSH, user `bldeploy`, `sudo docker ...`). Salt repo:
  `/src/salt` (separate git repo, also cloned locally on this Mac for reading).
- Compose invocation for prod, always all three: `-f
  /src/hydra-headless-ts/docker-compose.yml -f
  /etc/hydra-headless-ts/docker-compose.mariadb-mcp.prod.yml -p hydra-mcp`.
- `scripts/compose-env.sh` (new, on the branch) auto-resolves this — source it
  from any new script instead of re-deriving it.
