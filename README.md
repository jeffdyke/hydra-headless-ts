# Overview

This service implements a **headless OAuth2 login/consent provider** that bridges Ory Hydra (OAuth2 server with DCR) and Google OAuth (identity provider without DCR support).

## TLDR

This can be used as a connector in an AI Agent like Claude.ai that requires DCR, which Google doesn't support. The code uses Ory Hydra as
a OpenID Connect provider and Google as the OAuth Provider, routing a single client_id to your Google endpoint and keeping all of the client information
local in a PostGres DB, and using Redis for caching and sessions.

The underlying code originated from https://github.com/ory/hydra-login-consent-node, yet was completely modified to be written in typescript and only
the API calls.

### TODO

  Installation/documentation still depends on salt, which is fine if it can be dockerized
  Assumption that OAuth provider is google needs to be removed
  Likely More


In words, I could not write myself:
[Detailed breakdown of this OAuth2 flow](OAUTH2_ARCHITECTURE.md)

## Localhost vs Proxy

The code is written to run behind a proxy, or directly. It was developed behind HAProxy -> Nginx -> App.
Local development does not enable https

## Development Helpers

- [Dev Overview of Repository](./DEVELOPMENT.md)
- [Linting](./LINTING.md)
- [Quality Baseline](./QUALITY_BASELINE.mc)
- [Unit Tests](./README.test.md)

### Running Locally

To run this locally,

Simply change into the root of the repository:

- Update LocalDev settings, see [local.env](src/env/local.env)
- Run only watching compile errors `npm run tswatch`
- Launch the application `npm run build && npm run serve:local`

## Installing Docker Environment

The stack will not start until the config the services mount exists — compose
treats a missing `env_file` as fatal for the whole `up`, not just one service.

```bash
scripts/dev-bootstrap-env.sh        # copies samples into /etc/hydra-headless-ts
                                    # (never overwrites; prints a diff instead)
docker compose up -d
scripts/dev-register-client.sh      # one-time, and after any `down -v`
```

Two steps stay manual: filling the Google credentials in
`/etc/hydra-headless-ts/local.env`, and adding `http://localhost:8888/callback`
as an authorized redirect URI on that Google client. `dev-bootstrap-env.sh`
prints both when it finishes.

Verify the whole path with `scripts/validate-mcp-path.sh --local`.

### Nginx Configuration

nginx runs **in compose** for local development, serving <http://localhost:8888>
— the same entry point and port staging uses, including the `auth_request`
bearer gate on `/db-compare`. Config lives in
[`build/nginx/`](build/nginx/README.md); the dev virtual host is
[`build/nginx/dev/conf.d/hydra.conf`](build/nginx/dev/conf.d/hydra.conf).

Staging and prod are unchanged: there nginx runs on the **host** and Salt owns
the config (`salt/hydra-headless-ts` → `/etc/nginx/conf.d/hydra.conf`). Since
that makes two copies of the same routing rules,
`build/nginx/reference/hydra.conf.staging.example` keeps a verbatim staging
render as a baseline and `npm run check:nginx-drift` compares the two
structurally. Run it after editing either side, and refresh the reference when
the Salt template changes.
