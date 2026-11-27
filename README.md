# Canton agent toolkit

A TypeScript proof of concept for reading Canton ledger activity and proposing a Canton Coin (CC) payment from an MCP client. The demo runs on Splice LocalNet with a disposable wallet. Development concluded after the prototype.

## Why we built it

We wanted people to be able to ask “What happened on my Canton account?” or “Send 1 CC to this recipient” without learning the Ledger API or how to assemble a Daml command. The goal was a self-hosted toolkit that made those requests available to AI agents while preserving the party's ledger permissions and leaving signing and submission with the user's wallet.

The project explored three requests in the [Canton Foundation Development Fund roadmap](https://github.com/canton-foundation/canton-dev-fund/blob/main/2026-2028-strategic-roadmap.md#requests-for-proposals).

| RFP | What we wanted to explore |
| --- | --- |
| [14 · Wallet and dApp Integration tooling](https://github.com/canton-foundation/canton-dev-fund/blob/main/2026-2028-strategic-roadmap.md#developer-experience-tooling--education:~:text=Wallet%20and%20dApp%20Integration%20tooling) | Give agents a way to propose transactions under a local policy and hand them to a human for wallet review and signing. This was the main focus of the demo. |
| [19 · DPM Components and Extension Ecosystem](https://github.com/canton-foundation/canton-dev-fund/blob/main/2026-2028-strategic-roadmap.md#developer-experience-tooling--education:~:text=DPM%20Components%20and%20Extension%20Ecosystem) | Package the MCP as a reusable component for DPM, Canton's developer CLI. The prototype was built and run from this repository. |
| [20 · Indexers](https://github.com/canton-foundation/canton-dev-fund/blob/main/2026-2028-strategic-roadmap.md#developer-experience-tooling--education:~:text=Indexers%20and%20observability%20tools) | Explore agent access to transaction history while respecting Canton's privacy boundaries. The demo reads the Ledger API for one party. Query Store and public Scan tools stayed outside the prototype. |

## What the app does

If you come from Ethereum, think of a **Canton party** as the ledger identity an application acts for. Canton exposes only the ledger data that the authenticated session is authorized to see for that party. For writes, an app typically exercises a **choice** on a Daml contract, roughly like calling a method on an Ethereum smart contract. The demo's operation is a Canton Coin transfer. Users see **CC**, and the Splice transfer uses the instrument ID `Amulet`.

The [MCP server](src/mcp/) exposes structured tools. An agent can translate a chat request into a tool call, while Inspector lets you make the same call directly. For a payment, the server checks the local policy before queuing a proposal for wallet review and returning a **request ID**.

The policy sets boundaries for the agent. The demo generates a `policy.json` with an explicit list of allowed recipient party IDs, the allowed asset, and a maximum amount per payment. Bob is the only recipient in a fresh demo profile, and the per-payment cap is 10 CC. If the agent asks to send to a party outside that list or exceeds the cap, the MCP rejects the request before wallet review. Canton and the wallet enforce their own permissions.

The [wallet companion](src/wallet/companion.ts) uses the connected Wallet Gateway session for party-scoped reads and transaction preparation. For payments, it rechecks policy and verifies that the prepared payload matches the intended transfer before publishing a review link. The human approves in the wallet, and Wallet Gateway signs and submits. Once the MCP sees the matching ledger update, it returns an **update ID**. Think of that as the ID to look up the confirmed ledger record, similar to looking up an Ethereum transaction by hash.

[LocalNet setup](demo/localnet/) uses Splice to start a local Canton environment, create and fund disposable parties, and configure the recipient's transfer preapproval so the demo can complete in one transaction.

## Run the demo

You need Node.js 22 or newer, Bash, and a running Docker daemon with Docker Compose 2.24.4 or newer that your user can access. The launcher downloads npm packages and Docker images on the first run. Everything runs locally, including the ledger and Wallet Gateway.

From the repository root:

```sh
npm run demo
```

Keep that terminal open and **wait for the final `LocalNet demo` block** before continuing. Startup can take several minutes on the first run while Docker services start and the demo creates and funds the wallet and prepares Bob to receive payments. The terminal may go quiet during this setup.

The **LocalNet demo** block contains the disposable **Client ID** and **Client Secret**, plus links to the wallet connection page and Inspector. Start in your AI client's chat. The payment request will tell you if you need to connect the wallet.

### Connect your AI client

Use an AI client that can launch a **local MCP server over stdio**. Add a server named `canton-local-wallet` and set its command to the absolute path to `demo/localnet/mcp.sh` in this checkout. Use that client with your preferred model and make sure the server is enabled for the chat.

For example, with Codex CLI, run this from a second terminal in the repository root while the demo is running, then open a new Codex session.

```sh
codex mcp add canton-local-wallet -- "$PWD/demo/localnet/mcp.sh"
```

### Ask for a payment in chat

1. **Start with the payment.** Send the agent this message.

   > Send 1 CC to Bob.

   The agent can use the demo's allowed recipient list to find Bob's full Canton party ID even if the wallet is disconnected. The MCP saves the proposal and returns a request ID. **If the wallet is already connected to the running demo**, the companion reuses that session. Skip step 2 and open the approval link once the payment is ready. You still approve each payment in the wallet. **If the demo needs a wallet session**, the agent shares a connection link. Follow step 2 to continue with the same request.

2. **If the agent gives you a connection link, sign in.** Open that link and click **Connect Wallet Gateway**. Select **Splice LocalNet**, replace the prefilled Client ID, and enter the Client Secret. Copy both values from the demo terminal into the wallet form, then click **Connect**. If Gateway skips the login form and the connection fails, sign out in the Gateway window and retry from the connection page. Once the page confirms the connection, continue in the same chat.

   > I connected the wallet. Check the same payment request and give me the wallet approval link when it's ready.

   The agent checks the existing request ID. You only need one proposal for this payment.

3. **Review and approve.** If you already had a wallet session and the agent has only returned a request ID, ask it to check the same request for the approval link. Once the request reaches `awaiting_wallet_approval`, open the review link in the same browser and click **Open payment in Wallet Gateway**. Check the recipient and amount, then click **Approve**. The demo terminal also prints the transfer summary and review URL.

4. **Check the ledger outcome.** After approval, ask the agent for confirmation.

   > Check whether that payment was confirmed and show me the Canton ledger update ID.

   A successful transfer returns `confirmed` and an `update_id`. If you reject the payment in the wallet, the request reports `wallet_request_removed`.

Inspector is optional. Use the printed **MCP Inspector** URL if you want to inspect the tools or their responses directly.

To stop, press Ctrl+C in the demo terminal, then run `npm run demo -- down`. The Docker volumes and the generated profile are retained. The profile lives in `.localnet/wallet-profile/` by default. Edit `policy.json` to try a different per-payment cap or recipient list. A replacement recipient needs a transfer preapproval for this demo's one-step payment. Proposals and outcomes are saved under `requests/` within the profile.

## Why we stopped

We set out to make Canton workflows accessible to people who do not write Daml or integrate wallets. The payment prototype showed that a person can use a plain-language request once a workflow has been implemented. Our investigation found that extending this to arbitrary applications would still require a developer to find the right contract, build its commands, define the business policy, decide what the user should review, and verify the prepared transaction's effects. Daml definitions can describe a choice and its inputs, but the application owner still has to supply the business intent and approval rules. We did not find a reliable way to turn those decisions into a self-service setup for nontechnical users.

We also considered shipping the shared code as developer tooling. The proposal lifecycle, wallet session, and ledger reads offered some reuse, but the bulk of the work for each new workflow would still fall to its developer. That felt like too little added value for a separate toolkit, especially given related efforts such as the [Canton dApp SDK and tooling proposal](https://github.com/canton-foundation/canton-dev-fund/blob/main/proposals/2026-03-DA-Canton-Network-dapp-sdk-and-tooling.md) and the [BlockBot wallet integration proposal](https://github.com/canton-foundation/canton-dev-fund/pull/1056).

Wallet portability was another open question. The demo used the reference Wallet Gateway on LocalNet and relied on its session behavior and ability to inspect the exact prepared transaction. We did not validate the flow with a hosted wallet on DevNet, so we could not establish how much of the integration would carry over to other providers. We decided to leave the project as a reproducible example of a wallet-reviewed Canton payment.
