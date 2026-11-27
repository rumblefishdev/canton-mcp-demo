// Provision the sender wallet and its recipient on Splice LocalNet.
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { SDK } from "@canton-network/wallet-sdk";
import { z } from "zod";
import { readOptional, writeOnce } from "../../../dist/mcp/shared/files.js";
import { LedgerError } from "../../../dist/mcp/shared/ledger.js";
import { partySchema } from "../../../dist/mcp/shared/profile.js";
import { policySchema } from "../../../dist/mcp/tools/payments/payment-rules.js";
import { adminUser, localToken } from "../auth.js";
import { connectLedger } from "../ledger.js";
import {
  fixtureWallet,
  localGateway as gateway,
  walletUserFromProfile,
} from "./fixtures.js";

const ledgerUrl = "http://127.0.0.1:2975/";
const validatorUrl = "http://127.0.0.1:2903/api/validator";
const registryUrl = validatorUrl + "/v0/scan-proxy";
const scanApiUrl = "http://127.0.0.1:5012/api/scan";

async function waitForGateway() {
  for (let attempt = 0; attempt < 180; attempt++) {
    try {
      const response = await fetch(gateway.userApiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "ready",
          method: "listNetworks",
        }),
        signal: AbortSignal.timeout(1500),
      });
      if (
        response.ok &&
        z
          .object({
            result: z.object({
              networks: z
                .array(z.object({ id: z.literal(gateway.networkId) }))
                .min(1),
            }),
          })
          .safeParse(await response.json()).success
      )
        return;
    } catch {
      // The Gateway installs its pinned package on the first start.
    }
    await delay(1000);
  }
  throw new Error(
    "Wallet Gateway did not start. Check docker logs canton-mcp-wallet-gateway.",
  );
}

function createLocalSdk(
  auth: { method: "static"; token: string },
  synchronizer: string,
) {
  return SDK.create({
    auth,
    ledgerClientUrl: ledgerUrl,
    synchronizerId: synchronizer,
    token: { validatorUrl, registries: [registryUrl], auth },
    amulet: { validatorUrl, scanApiUrl, registryUrl, auth },
  });
}

async function provisionRecipient(
  sdk: Awaited<ReturnType<typeof createLocalSdk>>,
  fixtureFile: string,
) {
  const existing = await readOptional(fixtureFile);
  if (existing)
    return z.object({ bob: partySchema }).parse(JSON.parse(existing)).bob;
  // Bob's ephemeral key is used only to create his disposable preapproval.
  const key = sdk.keys.generate();
  const { partyId: bob } = await sdk.party.external
    .create(key.publicKey, { partyHint: "mcp-wallet-bob" })
    .sign(key.privateKey)
    .execute();
  const [tap, disclosures] = await sdk.amulet.tap(bob, "10");
  const { updateId } = await sdk.ledger
    .prepare({
      partyId: bob,
      commands: tap,
      disclosedContracts: disclosures,
    })
    .sign(key.privateKey)
    .execute({ partyId: bob });
  const preapproval = await sdk.amulet.preapproval.command.create({
    parties: { receiver: bob },
  });
  await sdk.ledger
    .prepare({ partyId: bob, commands: preapproval })
    .sign(key.privateKey)
    .execute({ partyId: bob });
  if (
    !(await sdk.amulet.preapproval.fetchStatus(bob, {
      timeoutMs: 150_000,
      intervalMs: 3_000,
    }))
  )
    throw new Error("Bob’s transfer preapproval did not become visible.");
  await writeOnce(fixtureFile, JSON.stringify({ bob, updateId }));
  return bob;
}

async function setup() {
  const location = process.env.CANTON_WALLET_LOCAL_PROFILE;
  const secret = process.env.WG_LOCALNET_SECRET;
  if (!location || !secret) throw new Error("Run npm run demo.");
  const directory = resolve(location);
  const configFile = join(directory, "config.json");
  const policyFile = join(directory, "policy.json");
  const existing = await readOptional(configFile);
  const profile: unknown = existing ? JSON.parse(existing) : undefined;
  const username = existing
    ? walletUserFromProfile(profile)
    : `mcp-wallet-${createHash("sha256").update(directory).update(secret).digest("hex").slice(0, 12)}`;
  if (!username)
    throw new Error("The existing LocalNet profile has no wallet user.");

  const auth = {
    method: "static" as const,
    token: localToken(adminUser, secret),
  };
  const ledger = connectLedger(ledgerUrl, auth.token);
  await waitForGateway();
  try {
    await ledger(`/v2/users/${username}`);
  } catch (error) {
    if (!(error instanceof LedgerError) || error.status !== 404) throw error;
    await ledger("/v2/users", { user: { id: username }, rights: [] });
  }

  const { provider, user, dapp, submit } = await fixtureWallet(
    username,
    secret,
  );
  const account = z.object({
    partyId: partySchema,
    primary: z.boolean().optional(),
  });
  const accounts = z.array(account).parse(await dapp("listAccounts"));
  const sender = existing
    ? z.object({ sender: partySchema }).parse(profile).sender
    : (accounts.find(({ primary }) => primary)?.partyId ??
      z.object({ wallet: account }).parse(
        await user("createWallet", {
          signingProviderId: "wallet-kernel",
          primary: true,
          partyHint: username,
        }),
      ).wallet.partyId);
  await provider.verifyAccount(sender);
  if (
    !accounts.find(({ partyId, primary }) => partyId === sender && primary) &&
    existing
  )
    await user("setPrimaryWallet", { partyId: sender });

  if (!existing) {
    const {
      connectedSynchronizers: [{ synchronizerId: synchronizer }],
    } = z
      .object({
        connectedSynchronizers: z.tuple([
          z.object({ synchronizerId: z.string() }),
        ]),
      })
      .parse(await ledger("/v2/state/connected-synchronizers"));
    const dso = await fetch(`${scanApiUrl}/v0/dso`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!dso.ok)
      throw new Error(
        `Could not discover the LocalNet DSO party (HTTP ${dso.status}).`,
      );
    const { dso_party_id: instrumentAdmin, amulet_rules } = z
      .object({
        dso_party_id: partySchema,
        amulet_rules: z.object({
          contract: z.object({ template_id: z.string() }),
        }),
      })
      .parse(await dso.json());
    const instrumentPackageId = amulet_rules.contract.template_id.split(":")[0];
    const sdk = await createLocalSdk(auth, synchronizer);

    await sdk.amulet.tapInternal("1000");
    const [commands, disclosedContracts] = await sdk.amulet.tap(sender, "50");
    await submit(sender, {
      commands: Array.isArray(commands) ? commands : [commands],
      disclosedContracts,
    });

    if (!(await readOptional(policyFile))) {
      const bob = await provisionRecipient(
        sdk,
        join(directory, "fixture.json"),
      );
      await writeOnce(
        policyFile,
        JSON.stringify(
          policySchema.parse({
            allowedAssets: ["CC"],
            allowedRecipients: [bob],
            maxAmount: "10",
          }),
          null,
          2,
        ),
      );
    }

    await writeOnce(
      configFile,
      JSON.stringify(
        {
          ledgerUrl,
          sender,
          synchronizer,
          registryUrl,
          instrumentAdmin,
          instrumentPackageId,
          walletUser: username,
          walletGateway: gateway,
        },
        null,
        2,
      ),
    );
  }
  console.log(
    `Wallet profile ready at ${directory}.\nWallet Gateway: ${new URL(gateway.userApiUrl).origin}\nLocalNet wallet user: ${username}`,
  );
}

try {
  await setup();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
