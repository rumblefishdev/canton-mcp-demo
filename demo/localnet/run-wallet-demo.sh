#!/usr/bin/env bash
# Start the wallet demo and an isolated Inspector with the right MCP profile.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."
case "${1:-up}" in
  down)
    bash demo/localnet/wallet/localnet.sh down
    bash demo/localnet/network.sh down
    exit
    ;;
  status)
    bash demo/localnet/network.sh status
    docker ps -a --filter name=^/canton-mcp-wallet-gateway$
    exit
    ;;
  up) ;;
  *)
    echo "Usage: npm run demo -- {up|down|status}" >&2
    exit 2
    ;;
esac

if ! command -v docker >/dev/null || ! docker info >/dev/null 2>&1; then
  echo "Start Docker and make sure your user can access it, then rerun npm run demo." >&2
  exit 1
fi

umask 077
cache=${CANTON_LOCALNET_CACHE:-"$PWD/.localnet"}
mkdir -p "$cache"
export CANTON_LOCALNET_CACHE
CANTON_LOCALNET_CACHE=$(cd "$cache" && pwd)
export CANTON_MCP_PROFILE_DIR="$CANTON_LOCALNET_CACHE/wallet-profile"
export CANTON_MCP_WALLET_READER_SOCKET="$CANTON_LOCALNET_CACHE/wallet-reader/ledger.sock"
inspector_file="$CANTON_LOCALNET_CACHE/wallet-inspector.json"

if [[ ! -x node_modules/.bin/tsc ]]; then
  npm ci
fi

bash demo/localnet/network.sh up
bash demo/localnet/wallet/localnet.sh up

demo_ports=$(node --input-type=module - "$inspector_file" "$PWD/demo/localnet/mcp.sh" <<'NODE'
import { writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { once } from "node:events";
const [file, command] = process.argv.slice(2);
writeFileSync(file, JSON.stringify({
  mcpServers: {
    "canton-local-wallet": {
      command,
      env: {
        CANTON_MCP_PROFILE_DIR: process.env.CANTON_MCP_PROFILE_DIR,
        CANTON_MCP_WALLET_READER_SOCKET: process.env.CANTON_MCP_WALLET_READER_SOCKET,
      },
    },
  },
}, null, 2), { mode: 0o600 });

// Gateway associates browser sessions with the companion origin. Use a fresh port per launch.
const listeners = Array.from({ length: 4 }, () => createServer());
try {
  const ports = await Promise.all(listeners.map(async (listener) => {
    listener.listen(0, "127.0.0.1");
    await once(listener, "listening");
    return listener.address().port;
  }));
  console.log(ports.join(" "));
} finally {
  for (const listener of listeners) listener.close();
}
NODE
)
read -r CLIENT_PORT MCP_SANDBOX_PORT MCP_APP_ORIGIN_PORT wallet_port <<< "$demo_ports"
export CANTON_WALLET_BROWSER_URL=${CANTON_WALLET_BROWSER_URL:-http://127.0.0.1:$wallet_port}

node dist/demo/wallet/review.js &
companion_pid=$!
trap 'kill "$companion_pid" 2>/dev/null || true; wait "$companion_pid" 2>/dev/null || true' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

export HOST=127.0.0.1
export CLIENT_PORT MCP_SANDBOX_PORT MCP_APP_ORIGIN_PORT
export MCP_STORAGE_DIR="$CANTON_LOCALNET_CACHE/inspector"
export MCP_AUTO_OPEN_ENABLED=false
export MCP_INSPECTOR_API_TOKEN
MCP_INSPECTOR_API_TOKEN=$(node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))')
wallet_user=$(node --input-type=module - "$CANTON_MCP_PROFILE_DIR/config.json" <<'NODE'
import { readFileSync } from "node:fs";
const profile = JSON.parse(readFileSync(process.argv[2], "utf8"));
const user = profile.walletUser ?? profile.signerUser;
if (typeof user !== "string" || !user) throw new Error("The profile has no wallet user.");
console.log(user);
NODE
)

print_demo_credentials() {
  printf '\nLocalNet demo\n'
  printf '  Wallet connection: %s\n' "$CANTON_WALLET_BROWSER_URL"
  printf '  MCP Inspector:     http://127.0.0.1:%s/?MCP_INSPECTOR_API_TOKEN=%s\n' "$CLIENT_PORT" "$MCP_INSPECTOR_API_TOKEN"
  printf '  Network:           Splice LocalNet\n'
  printf '  Client ID:         %s\n' "$wallet_user"
  printf '  Client Secret:     %s\n' "$(< "$CANTON_LOCALNET_CACHE/auth-secret")"
}

# The current Inspector requires a newer Node release than some repo-supported Node 22 installations.
npm exec --yes --package=node@24.22.3 -- \
  npm exec --yes --package=@modelcontextprotocol/inspector@2.16.0 -- \
  mcp-inspector --web --config "$inspector_file" |
  {
    # Inspector 2.16 ends its startup banner with the secrets storage line.
    while IFS= read -r line; do
      printf '%s\n' "$line"
      if [[ "$line" == "   Secrets: "* ]]; then
        print_demo_credentials
        break
      fi
    done
    cat
  }
