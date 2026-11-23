# Canton LocalNet walkthrough

This walkthrough starts a local Canton network with Splice. An MCP client can inspect Alice’s authorized ledger history, propose a Canton Coin transfer to Bob, or propose that Alice approve a Splitwell group request. The terminal signer verifies the prepared Canton transaction and asks a human to approve or reject it. On approval, the signer submits the verified transaction. The MCP container has an Alice-only read credential and mounts the proposal state directory. The key and signing credential are kept separately on the host.

From the repository root, with Node.js 22+ and Docker Compose 2.24.4+ installed:

```sh
npm ci
npm run payments:localnet -- up
```

First startup downloads the pinned Splice release and container images. Setup creates two disposable parties, seeds test Canton Coin, and configures Bob to receive the transfer in one step. It also creates a Bob-only ledger update and verifies that Canton denies an explicit Bob history query using Alice’s credentials and hides that update from Alice’s authorized view.

Add the following entry to your MCP client configuration. Replace the path with your checkout’s absolute path.

```json
{
  "mcpServers": {
    "canton-payments": {
      "command": "/absolute/path/to/canton-mcp-demo/demo/localnet/mcp.sh"
    }
  }
}
```

## Transfer Canton Coin

1. Ask the client to show Alice’s recent activity and propose sending **2 Amulet** to the configured recipient. The client can get Bob’s party ID from `payment_context`.
2. In a separate terminal, review the request. Check the sender, recipient, amount, and asset, then type `approve`.

   ```sh
   npm run payments:review -- REQUEST_ID
   ```

3. Ask the client to check `payment_status` and retrieve the resulting update using `get_activity`. You can also type `reject` on a fresh proposal to see the rejection path. A proposal above the default **10 Amulet** limit returns `policy_rejected`.
4. For a quick expiry check, temporarily set `reviewSeconds` in `.payments/policy.json` to `5`, propose a payment, and wait 5 seconds before checking its status. Restore the default of 300 seconds afterward.

## Approve a Splitwell group request

1. Seed a fresh group request and copy the `contract_id` printed by the command.

   ```sh
   npm run --silent actions:seed-group
   ```

   The seeder uses the Splitwell Daml package bundled with Splice. Alice acts as the Splitwell provider, and the LocalNet operator requests a new group as its owner. On first use, the seeder adds a `groupRequests` policy to the profile. That policy pins the package ID, allows the LocalNet owner, and gives Alice five minutes to review each proposal.

2. In Inspector, run `propose_accept_group_request` with that `contract_id`. The tool loads the request from Canton using Alice’s read credential and returns the requested terms and a `request_id`.
3. Review the proposed action in a terminal. Check the group name, owner, and provider, then type `approve`.

   ```sh
   npm run actions:review -- REQUEST_ID
   ```

4. Call `action_status` with that request ID, then use the returned `update_id` with `get_activity`. The Canton update shows a `GroupRequest_Accept` exercise and a new `Group` contract. The original request is consumed. To try again, seed a new request.

## State and checks

The policy lives at `.payments/policy.json`. The MCP container mounts the policy read-only. Each proposal’s decision and ledger outcome are persisted in files under `.payments/requests/<request-id>/`. If submission is uncertain, `action_status` looks up the exact approved transaction hash. `payment_status` also supports this lookup for payments.

```sh
npm run payments:check-privacy
npm run actions:check
npm run payments:localnet -- status
npm run payments:localnet -- down
```

`actions:check` submits 2 test Amulet, approves a new Splitwell group, and exercises rejection, expiry, privacy, and confirmation recovery. `payments:check` runs the payment checks on their own. `down` stops LocalNet and preserves its Docker volumes. Keep `.localnet`, `.payments`, and `.payment-signer` together with those volumes for subsequent runs. Running `up` again refreshes the local credentials.

The default setup uses a local Splice network. Live DevNet validation requires a hosted participant, party-scoped credentials, a compatible signer, and test funds.

The LocalNet startup script builds the demo TypeScript separately from the MCP server. [`setup.ts`](setup.ts) creates and funds the test parties, writes their profile, and checks their permissions. [`check-payments.ts`](check-payments.ts) runs the workflows through MCP and checks the resulting ledger activity. The [reference signer](signer/) reads its credential and key from `.payment-signer/` by default. See the [toolkit README](../../README.md) for the standalone server.
