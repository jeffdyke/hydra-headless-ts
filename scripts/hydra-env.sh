#!/usr/bin/env bash
# set -x
# This has not been kept up to date, need better information for non salt based installs
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
SET_KEY="${1}"
TMP_FILE=/tmp/set_hydra.yml
YQ_Q='.base'
if [ ! -z "${SET_KEY}" ]; then
  YQ_Q="${YQ_Q} * .${SET_KEY}"
fi

yq "${YQ_Q}" hydra_pillar.yml | grep -vE "^[&\!\<]" > $TMP_FILE
jinja2 hydra.yml "${TMP_FILE}"
rm -f ${TMP_FILE}
