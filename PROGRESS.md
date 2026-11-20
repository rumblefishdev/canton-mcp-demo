# Canton agent toolkit progress

## Project goal

Build one open-source, self-hosted toolkit for Canton, targeting RFPs 14, 19, and 20. The TypeScript MCP server gives AI agents a way to read Canton data and propose transactions. The configured party’s permissions govern access to private data. A human reviews and signs each proposed transaction through a separate signer that holds the private key.

- Provide read tools for the Canton Ledger API, the Postgres query store, and the public network API. Support party-scoped transaction history.
- Let agents prepare transactions for human review. Use a configurable policy to constrain allowed actions and an audit log to record proposals, decisions, and submission outcomes.
- Package the toolkit as a DPM extension.

## What we have today

The [demo](README.md) runs a TypeScript MCP server and a separate operator CLI against a Canton 3.7.4 test ledger in Docker Compose. It uses Canton’s built-in `Ping` contract to demonstrate external signing with two test parties, Alice and Bob.

1. The agent calls `prepare_ping` to prepare a Ping from Alice to Bob and receives a request ID.
2. The operator CLI recomputes the prepared transaction hash, checks that the transaction matches the expected Ping, and prompts a human to approve or reject. On approval, the CLI signs and submits it. Only the operator container mounts Alice’s test key.
3. The agent calls `ping_status` to check the request outcome and retrieve the Canton update ID when confirmed. It can call `list_active_pings` to see Alice’s active Ping contracts.

## What remains

- Add authenticated Ledger API access that enforces the configured party’s permissions. The demo uses one participant and an unauthenticated API on the Docker network.
- Implement private transaction history, Postgres query-store access, and public network API tools. The current read tools cover active Pings and demo request status.
- Extend preparation and review to additional Canton actions. Replace the hard-coded Ping checks with a configurable policy, add a durable audit log, and integrate a wallet or external signer for deployment.
- Build and document the DPM extension. Docker Compose is the current way to run the demo.
