# Canton agent toolkit

The MCP server reads Canton activity visible to a configured party, queues policy-checked proposals, and tracks their ledger outcome. A separate signer reviews and submits transactions. The LocalNet demo covers both a Canton Coin transfer and approval of a Splitwell group request.

## Connect to a Canton participant

Install dependencies and build the server with Node.js 22 or later.

```sh
npm ci
npm run build
```

For a participant you already have access to, create a profile directory with these three files.

| File | Contents |
|---|---|
| `config.json` | `ledgerUrl` for the participant’s JSON Ledger API and `sender` for the Canton party ID. |
| `reader.jwt` | A Ledger API access token authorized to read as the sender. |
| `policy.json` | Operator policy for each enabled workflow. The payment policy sets allowed assets and recipients, a per-payment cap, and a review window. |

For example, a policy for up to 10 Amulet per payment with five minutes for approval looks like this. Replace the recipient placeholder with the full Canton party ID.

```json
{
  "allowedAssets": ["Amulet"],
  "allowedRecipients": ["<recipient party ID>"],
  "maxAmount": "10",
  "reviewSeconds": 300
}
```

Generate the MCP client configuration from the repository root. Replace the path with your profile directory, then add the printed entry to your client.

```sh
CANTON_PAYMENT_DIRECTORY=/absolute/path/to/profile npm run --silent client-config
```

The generated command launches the stdio server directly. It uses the profile you supplied. In an MCP client or Inspector, call `payment_context` to check which party and policy are active.

The [LocalNet walkthrough](demo/localnet/README.md) provisions a working profile and a reference terminal signer for both workflows. A hosted DevNet participant and an existing-wallet integration are listed in [project progress](PROGRESS.md).

## Add a workflow

1. Add a tool module and its workflow-specific helpers in a feature folder under [`src/mcp/tools/`](src/mcp/tools/) and register it in the [tool index](src/mcp/tools/index.ts). Use [`registerAction`](src/mcp/shared/actions.ts) to supply the workflow’s Zod input schema and policy check. For example, `propose_payment` takes a recipient and amount. `propose_accept_group_request` takes a contract ID and reads the terms through the configured party’s Ledger API permissions.
2. For the reference signer, register a [reviewer](demo/localnet/signer/reviewers.ts) for the same action ID. The reviewer rechecks policy, constructs the Canton commands, and verifies the decoded transaction before displaying what the human will approve. The [payment reviewer](demo/localnet/signer/payment.ts) uses the Wallet SDK to assemble a token transfer. The [Splitwell reviewer](demo/localnet/signer/group-request.ts) checks that the prepared transaction consumes the selected request and creates the group with the advertised terms.
3. Use the existing `action_status` tool to check the decision or get the Canton update ID. The toolkit assigns the request ID, enforces expiry, saves the decision and approved hash, and uses that hash to recover confirmation after a lost submission response. The terminal signer handles the approval prompt, signing, and submission.

The tool folders group [activity](src/mcp/tools/activity/), [payments](src/mcp/tools/payments/), and [Splitwell](src/mcp/tools/splitwell/). The ledger client, profiles, and the proposal lifecycle live in [`src/mcp/shared/`](src/mcp/shared/). [`demo/localnet/`](demo/localnet/) contains the optional Splice setup, fixtures, signer example, and integration checks.

The [server factory](src/mcp/server/index.ts) registers the tools, and the [stdio transport](src/mcp/transports/stdio.ts) connects it to the client. This layout follows the [MCP Everything reference server](https://github.com/modelcontextprotocol/servers/tree/main/src/everything). Run `npm run format` to format the TypeScript or `npm run format:check` to check it.
