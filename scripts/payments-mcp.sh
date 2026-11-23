#!/usr/bin/env bash
set -euo pipefail

# Keep existing LocalNet Inspector and MCP client configurations working.
repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
exec "$repo/demo/localnet/mcp.sh" "$@"
