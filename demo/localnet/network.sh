#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."
repo=$PWD
version=0.9.4
bundle_sha256=26bb61ffd76d8e3db37a310df5b70252274d35edb324d24d2b0db66388fb6170
cache=${CANTON_LOCALNET_CACHE:-"$repo/.localnet"}
export IMAGE_TAG=$version
export LOCALNET_DIR=${CANTON_LOCALNET_DIRECTORY:-"$cache/splice-node/docker-compose/localnet"}
export CANTON_LOCALNET_OVERRIDES="$cache/overrides"
export DOCKER_NETWORK=${CANTON_LOCALNET_NETWORK:-canton-mcp-localnet}
# Splice's validator party format does not accept the hyphens in the network name.
export PARTY_HINT=${PARTY_HINT:-cantonmcp-localparty-1}
export ALPHA_PROTOCOL_VERSION_ENV="$LOCALNET_DIR/env/alpha-protocol-version-unused.env"
project=${CANTON_LOCALNET_PROJECT:-canton-mcp-localnet}
action=${1:-up}

upstream=(
  docker compose -p "$project"
  --env-file "$LOCALNET_DIR/compose.env" --env-file "$LOCALNET_DIR/env/common.env"
  -f "$LOCALNET_DIR/compose.yaml" -f "$LOCALNET_DIR/resource-constraints.yaml" -f "$repo/demo/localnet/compose.yaml"
  --profile sv --profile app-provider --profile app-user
)

case "$action" in
  up)
    umask 077
    mkdir -p "$cache" "$CANTON_LOCALNET_OVERRIDES"
    if [[ ! -f "$LOCALNET_DIR/compose.yaml" ]]; then
      if [[ -n ${CANTON_LOCALNET_DIRECTORY:-} ]]; then
        echo "LocalNet directory does not contain compose.yaml: $LOCALNET_DIR" >&2
        exit 1
      fi
      bundle="$cache/$version-splice-node.tar.gz"
      download_url="https://github.com/digital-asset/decentralized-canton-sync/releases/download/v$version/${version}_splice-node.tar.gz"
      curl --fail --location --retry 2 "$download_url" --output "$bundle.part"
      node --input-type=module -e '
        import { createHash } from "node:crypto";
        import { createReadStream } from "node:fs";
        const hash = createHash("sha256");
        for await (const chunk of createReadStream(process.argv[1])) hash.update(chunk);
        if (hash.digest("hex") !== process.argv[2]) throw new Error("Splice release checksum mismatch.");
      ' "$bundle.part" "$bundle_sha256"
      # Docker mounts the release's scripts and configuration into unprivileged containers.
      (umask 022; tar -xzf "$bundle.part" -C "$cache")
      rm "$bundle.part"
    fi
    if [[ -z ${CANTON_LOCALNET_DIRECTORY:-} ]]; then
      # Repair cached bundles extracted with the earlier restrictive umask.
      chmod -R a+rX "$LOCALNET_DIR/conf" "$LOCALNET_DIR/docker"
    fi
    if [[ ! -s "$cache/auth-secret" ]]; then
      node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))' > "$cache/auth-secret"
    fi
    export CANTON_LOCALNET_AUTH_SECRET
    CANTON_LOCALNET_AUTH_SECRET=$(< "$cache/auth-secret")
    sed 's/secret = "unsafe"/secret = ${CANTON_LOCALNET_AUTH_SECRET}/g' \
      "$LOCALNET_DIR/conf/canton/app-user/app-auth.conf" > "$CANTON_LOCALNET_OVERRIDES/canton-auth.conf"
    sed 's/secret = "unsafe"/secret = ${CANTON_LOCALNET_AUTH_SECRET}/g' \
      "$LOCALNET_DIR/conf/splice/app-user/app-auth.conf" > "$CANTON_LOCALNET_OVERRIDES/splice-auth.conf"
    # The Docker service users must be able to read the overrides. Only the separate secret file contains the key.
    chmod 644 "$CANTON_LOCALNET_OVERRIDES/"*.conf
    "${upstream[@]}" up -d --wait --wait-timeout 360
    ;;
  down|status)
    if [[ ! -f "$cache/auth-secret" ]]; then
      echo "LocalNet has not been started by this script." >&2
      exit 1
    fi
    export CANTON_LOCALNET_AUTH_SECRET
    CANTON_LOCALNET_AUTH_SECRET=$(< "$cache/auth-secret")
    if [[ "$action" == down ]]; then
      "${upstream[@]}" down
    else
      "${upstream[@]}" ps
    fi
    ;;
  *)
    echo "Usage: npm run demo -- {up|down|status}" >&2
    exit 2
    ;;
esac
