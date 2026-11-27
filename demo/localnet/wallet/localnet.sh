#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../../.."
cache=${CANTON_LOCALNET_CACHE:-"$PWD/.localnet"}
network=${CANTON_LOCALNET_NETWORK:-canton-mcp-localnet}
wallet_profile="$cache/wallet-profile"
gateway=canton-mcp-wallet-gateway

remove_gateway() {
  if docker container inspect "$gateway" >/dev/null 2>&1; then
    docker rm -f "$gateway" >/dev/null
  fi
}

case "${1:-up}" in
  up)
    if [[ ! -s "$cache/auth-secret" ]]; then
      echo "Start Splice LocalNet with npm run demo." >&2
      exit 1
    fi
    umask 077
    npm run build:localnet
    docker build -t canton-mcp-demo:local "$PWD"
    mkdir -p "$wallet_profile"
    export WG_LOCALNET_SECRET
    WG_LOCALNET_SECRET=$(< "$cache/auth-secret")
    # Compose may recreate the network under the same name. Reattach a new
    # Gateway container and keep its wallet data in the named volume.
    remove_gateway
    docker run -d --name "$gateway" --network "$network" \
      --publish 127.0.0.1:3030:3030 --env WG_LOCALNET_SECRET \
      --mount "type=bind,source=$PWD/demo/localnet/wallet/gateway-config.json,target=/gateway.json,readonly" \
      --mount "type=volume,source=canton-mcp-wallet-state,target=/wallet-state" \
      --env npm_config_cache=/wallet-state/npm node:24-bookworm-slim \
      npx --yes @canton-network/wallet-gateway-remote@1.14.0 -c /gateway.json >/dev/null
    CANTON_WALLET_LOCAL_PROFILE="$wallet_profile" node dist/demo/wallet/setup.js
    ;;
  down)
    remove_gateway
    ;;
  *)
    echo "Usage: npm run demo -- {up|down}" >&2
    exit 2
    ;;
esac
