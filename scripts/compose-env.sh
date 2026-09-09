#!/usr/bin/env bash
# Shared docker compose resolution for scripts that talk to the running
# hydra-headless-ts / mariadb-mcp stack. Sourced, not executed.
#
# There is no single default docker-compose.yml + project any more:
#
#   * A deployed host (salt/hydra-headless-ts's init.sls, in the salt repo)
#     starts the stack via /etc/init.d/hydra-mcp with
#       -f /src/hydra-headless-ts/docker-compose.yml
#       -f /etc/hydra-headless-ts/docker-compose.mariadb-mcp.<env>.yml
#       -p hydra-mcp
#     (see that script's PATHS/OPTS). docker-compose.yml pins `name: hydra`,
#     so a *bare* `docker compose` in a checkout there resolves to project
#     "hydra" -- a different project than the one actually running -- so
#     `ps`/`exec` silently miss the real containers, and `up` starts a
#     second, conflicting stack.
#   * A local dev checkout has no /etc/init.d/hydra-mcp; LOCAL_TESTING.md's
#     documented `-f docker-compose.yml -f docker-compose.mariadb-mcp.dev.yml`
#     (project "hydra", from docker-compose.yml's own `name:`) is what's
#     running.
#
# Auto-detect which of those this host is, rather than requiring a flag.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)"

if [ "$(uname)" = "Darwin" ]; then
  DOCKER_CMD="docker"
else
  DOCKER_CMD="sudo docker"
fi

if [ -x /etc/init.d/hydra-mcp ]; then
  DEPLOYED=1
  BASE_COMPOSE="/src/hydra-headless-ts/docker-compose.yml"
  mcp_fragments=(/etc/hydra-headless-ts/docker-compose.mariadb-mcp.*.yml)
  if [ ! -e "${mcp_fragments[1]}" ]; then
    echo "error: /etc/init.d/hydra-mcp exists but no /etc/hydra-headless-ts/docker-compose.mariadb-mcp.*.yml fragment was found" >&2
    exit 1
  fi
  if [ "${#mcp_fragments[@]}" -gt 1 ]; then
    echo "error: expected exactly one mariadb-mcp compose fragment in /etc/hydra-headless-ts, found: ${mcp_fragments[*]}" >&2
    exit 1
  fi
  MCP_COMPOSE="${mcp_fragments[1]}"
  COMPOSE_PROJECT="hydra-mcp"
  # docker-compose.mariadb-mcp.<env>.yml -> <env> (e.g. "prod", "staging"), the
  # same <env> salt/hydra-headless-ts's init.sls used to render this fragment
  # and to pick pillar/<env>/oauth's dcr_client_id -- see dev-register-client.sh.
  mcp_fragment_basename="$(basename "$MCP_COMPOSE")"
  COMPOSE_ENV="${mcp_fragment_basename#docker-compose.mariadb-mcp.}"
  COMPOSE_ENV="${COMPOSE_ENV%.yml}"
else
  DEPLOYED=0
  BASE_COMPOSE="${REPO_ROOT}/docker-compose.yml"
  MCP_COMPOSE="${REPO_ROOT}/docker-compose.mariadb-mcp.dev.yml"
  COMPOSE_PROJECT="hydra"
  COMPOSE_ENV="dev"
fi

COMPOSE_ARGS=(-f "$BASE_COMPOSE" -f "$MCP_COMPOSE" -p "$COMPOSE_PROJECT")
# Space-joined for echoing copy-pasteable commands only -- none of these paths
# contain spaces, so this is safe for display purposes.
COMPOSE_ARGS_STR="${COMPOSE_ARGS[*]}"

compose() {
  $DOCKER_CMD compose "${COMPOSE_ARGS[@]}" "$@"
}

hydraComposeCmd() {
  echo "$DOCKER_CMD compose ${COMPOSE_ARGS[*]}"
}
