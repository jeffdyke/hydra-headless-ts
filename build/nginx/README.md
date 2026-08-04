# nginx for local development

`docker-compose.yml` runs nginx on **http://localhost:8888**, the same entry point
and the same port staging uses. Staging and prod are **not** affected by anything
here: there, nginx runs on the host and Salt owns the config
(`salt/hydra-headless-ts` → `/etc/nginx/conf.d/hydra.conf`).

The reason this exists: routing, CORS, and the `.well-known` documents are all
enforced by nginx, so without nginx in compose they could not be exercised
without deploying. `scripts/validate-mcp-path.sh --local` now tests them.

## Layout

| path | mounted at | env var |
|---|---|---|
| `nginx.conf` | `/etc/nginx/nginx.conf` | `NGINX_MAIN_CONF` |
| `shared/cors_headers`, `shared/options_request` | `/etc/nginx/` | `NGINX_ETC_DIR` |
| `dev/conf.d/` | `/etc/nginx/conf.d/` | `NGINX_CONF_DIR` |
| `www/` | `/var/www/html/` | `NGINX_WWW_DIR` |
| `reference/hydra.conf.staging.example` | — never mounted | — |

Set the vars in a `.env` beside `docker-compose.yml` to point the container at a
Salt-rendered host tree instead:

```
NGINX_CONF_DIR=/etc/nginx/conf.d
NGINX_ETC_DIR=/etc/nginx
NGINX_WWW_DIR=/var/www/html
```

`NGINX_MAIN_CONF` is the one that **cannot** be repointed at Salt's
`/etc/nginx/nginx.conf`: that file does `load_module ngx_http_js_module.so`,
`js_import utils.js` and a `custom_json` log format built on `$headers_json`, and
`nginx:alpine` ships no njs module. Containerising staging would mean keeping the
repo's `nginx.conf` or adding a Dockerfile with `nginx-module-njs`.

## Keeping this in step with Salt

`dev/conf.d/hydra.conf` and Salt's template are two copies of the same routing
rules. Every intended difference is labelled `T1`–`T9` in the dev conf's header
comments, and `scripts/check-nginx-drift.sh` (`npm run check:nginx-drift`)
compares the two **structurally** — locations, which carry `auth_request`, the
`proxy_pass` path suffixes, the upstream name set — while normalising T1–T9 away.

`reference/hydra.conf.staging.example` is the baseline: a verbatim render
captured from a staging host. **Refresh it whenever the Salt template changes**,
using the scp line in its own header. A stale baseline is this check's only blind
spot, so the script prints the file's capture date on every run.

## Known dev/staging differences beyond T1–T9

- The `.well-known/oauth-protected-resource/*` documents under `www/` are written
  as **one JSON object each**. Salt's
  `oauth-protected-resource.json.jinja2` loops over `protected_resources`
  internally while `init.sls` also passes a single `resource`, so each deployed
  file contains N concatenated objects and is not valid JSON. The dev copies are
  deliberately correct; this is a Salt bug to fix separately, not drift.
- No `/hostname` or `/hostname.html` locations (T7): those are HAProxy ops URLs
  and the file they serve is generated on the instance by Salt.

## Failure cheatsheet

| symptom | cause |
|---|---|
| `nginx exited (1)`, `host not found in upstream` | a backend container is down. nginx resolves upstream names at **config load**. `docker compose ps` |
| every request resets / `broken header` | `proxy_protocol` left on `listen` (T2). There is no HAProxy locally |
| 401 challenge names `https://localhost` or drops `:8888` | T8 missed — `$scheme://$http_host`, not `https://$host` |
| a redirect loses the port | T4 missed — `$http_host`, not `$host` |
| `open() "/etc/nginx/cors_headers" failed` | the bind mount path was wrong, so Docker created a **directory** there |
| `/db-tools` returns 502 | mariadb-mcp is down — it exits at startup when it cannot reach the database (check `DB_HOST`/`DB_PASSWORD` in mariadb-mcp.env). T9 keeps it from taking nginx with it |

## Prerequisites

`docker compose up` fails outright if the `env_file` targets are missing, so run
this first:

```bash
scripts/dev-bootstrap-env.sh     # copies samples into /etc/hydra-headless-ts
```

It never overwrites an existing file; it prints a diff instead. Then see the
manual steps it lists — Google console redirect URI, and
`scripts/dev-register-client.sh` for the Hydra client.

Note `redis` publishes 6379 and may collide with another compose project on your
machine; bring services up by name if so.
