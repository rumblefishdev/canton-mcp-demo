#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."
state=${CANTON_MCP_PROFILE_DIR:-${CANTON_PAYMENT_DIRECTORY:-"${CANTON_LOCALNET_CACHE:-$PWD/.localnet}/wallet-profile"}}
socket=${CANTON_MCP_WALLET_READER_SOCKET:-"${CANTON_LOCALNET_CACHE:-$PWD/.localnet}/wallet-reader/ledger.sock"}

if [[ ! -f "$state/config.json" ]]; then
  echo "Start the LocalNet payment demo before connecting the MCP client." >&2
  exit 1
fi

umask 077
mkdir -p "$state/requests"
reader_dir=$(dirname "$socket")
reader_name=$(basename "$socket")
mkdir -p "$reader_dir"
exec docker run --rm -i --read-only --network none --user "$(id -u):$(id -g)" \
  --mount "type=bind,source=$state,target=/profile,readonly" \
  --mount "type=bind,source=$state/requests,target=/profile/requests" \
  --env CANTON_MCP_PROFILE_DIR=/profile \
  --mount "type=bind,source=$reader_dir,target=/run/canton-wallet-reader,readonly" \
  --env "CANTON_MCP_WALLET_READER_SOCKET=/run/canton-wallet-reader/$reader_name" \
  canton-mcp-demo:local
