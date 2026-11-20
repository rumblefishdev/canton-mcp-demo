# Canton MCP signing demo

This demo uses a real Canton 3.7.4 test ledger. An MCP client can prepare a request to create a built-in `Ping` contract from Alice to Bob. An operator reviews it in a separate terminal, recomputes the Canton transaction hash, and chooses whether to sign and submit. The client can then query the result and Alice’s active Ping contracts.

The built-in contract lets us exercise external signing without a custom Daml package, token funding, or Splice. The demo uses a single local participant, an unauthenticated Ledger API, and a disposable test key. In Docker, the Ledger API is reachable through the Compose network and no host ports are published.

The MCP server and operator CLI are written in TypeScript. Both call Canton's JSON Ledger API. The operator CLI uses Canton's TypeScript hashing library to verify each prepared transaction before signing. In Docker, only the operator container mounts the volume that holds the test signing key.

## Run with Docker Compose

From the `demo` directory, build the demo images, start Canton, and initialize the test parties.

```sh
docker compose build canton mcp
docker compose up -d --wait canton
docker compose run --rm operator onboard
```

Add this entry to your MCP client configuration. Use the absolute path to the `demo` directory.

```json
{
  "mcpServers": {
    "canton-demo": {
      "command": "docker",
      "args": ["compose", "--project-directory", "/absolute/path/to/demo", "run", "--rm", "-T", "mcp"]
    }
  }
}
```

Call `prepare_ping` in the MCP client and pass the returned request ID to the operator CLI from the `demo` directory.

```sh
docker compose run --rm operator review REQUEST_ID
```

Type `approve` or `reject`, then call `ping_status` with the request ID. Use `list_active_pings` to inspect Alice’s active Ping contracts. Requests expire after five minutes.

Docker Compose stores request state and outcomes in the `demo-state` volume and Alice’s test signing key in the `signer-state` volume. Inside the containers, these volumes appear as `/app/.state` and `/app/.signer`.

Canton’s demo ledger runs in memory. To start a fresh session after stopping the node, disconnect the MCP client, run `docker compose down --volumes` to discard the demo state and test key, and repeat startup and onboarding.
