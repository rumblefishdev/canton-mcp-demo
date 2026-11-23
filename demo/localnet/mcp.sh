#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."
state=${CANTON_PAYMENT_DIRECTORY:-"$PWD/.payments"}
network=${CANTON_LOCALNET_NETWORK:-canton-mcp-localnet}

if [[ ! -f "$state/config.json" ]]; then
  echo "Start the LocalNet payment demo before connecting the MCP client." >&2
  exit 1
fi

umask 077
mkdir -p "$state/requests"
exec docker run --rm -i --read-only --network "$network" --user "$(id -u):$(id -g)" \
  --mount "type=bind,source=$state,target=/app/.payments,readonly" \
  --mount "type=bind,source=$state/requests,target=/app/.payments/requests" \
  --env CANTON_PAYMENT_LEDGER_URL=http://canton:2975 canton-mcp-demo:local
