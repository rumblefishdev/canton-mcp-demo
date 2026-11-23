# Canton agent toolkit progress

## Project goal

Build one open-source, self-hosted toolkit for Canton, targeting RFPs 14, 19, and 20. The TypeScript MCP server gives AI agents a way to read Canton data and propose transactions. The configured party’s permissions govern access to private data. A human reviews and signs each proposed transaction through a separate signer that holds the private key.

- Provide read tools for the Canton Ledger API, the Postgres query store, and the public network API. Support party-scoped transaction history.
- Let agents prepare transactions for human review. Use a configurable policy to constrain allowed actions and an audit log to record proposals, decisions, and submission outcomes.
- Package the toolkit as a DPM extension.

## What we have today

The MCP server uses a Canton profile for its participant URL, party, read credential, and policy. It provides party-scoped activity and two policy-checked actions. One transfers Canton Coin. The other accepts a Splitwell group request and creates a group on Canton.

Both actions use the same proposal, expiry, approval, and ledger-confirmation workflow. Each defines its own inputs, policy, Canton commands, and signer verification. The reference terminal signer verifies the prepared transaction and its hash before prompting for approval. The runtime can recover a confirmation by looking up the approved hash.

The optional [LocalNet walkthrough](demo/localnet/README.md) uses Splice 0.9.4 to fund disposable external parties and generate a profile for that same MCP server.

## What remains

- Validate the payment workflow against a hosted DevNet participant and integrate a deployment wallet or custody signer. The LocalNet signer holds a disposable key.
- Have an independent Canton team try adding an action from their own Daml application.
- Add Participant Query Store support for a concrete investigation workflow. Add public Scan access when a pilot calls for it.
- Package and document a DPM component.
