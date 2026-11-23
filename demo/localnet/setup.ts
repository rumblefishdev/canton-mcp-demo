import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { SDK } from "@canton-network/wallet-sdk";
import { z } from "zod";
import {
  readOptional,
  replaceFile,
  writeOnce,
} from "../../dist/mcp/shared/files.js";
import {
  configFile,
  profileDirectory,
  profileFields,
  policyFile,
  readProfile,
  readProfileDocument,
  readerTokenFile,
  readToken,
} from "../../dist/mcp/shared/profile.js";
import { asset } from "../../dist/mcp/tools/payments/payment-rules.js";
import {
  LedgerError,
  getTransaction,
  ledgerEnd,
  connectLedger,
  pruningOffset,
  readTransactions,
} from "../../dist/mcp/shared/ledger.js";
import { adminUser, localToken } from "./auth.js";
import {
  paymentSignerFields,
  signerKeyFile,
  signerProfileFields,
  signerTokenFile,
} from "./signer/config.js";

const ledgerUrl = "http://127.0.0.1:2975/";
const validatorUrl = "http://127.0.0.1:2903/api/validator";
const registryUrl = "http://127.0.0.1:2903/api/validator/v0/scan-proxy";
const scanApiUrl = "http://127.0.0.1:5012/api/scan";
const fixtureFile = join(profileDirectory, "fixture.json");
const localProfileSchema = z.object({
  ...profileFields,
  ...signerProfileFields,
  ...paymentSignerFields,
  readerUser: z.string().min(1),
});

async function checkPartyIsolation() {
  const data = await readOptional(fixtureFile);
  if (!data)
    throw new Error("Run LocalNet setup to create the privacy fixture.");
  const fixture = z
    .object({ bob: z.string(), updateId: z.string() })
    .parse(JSON.parse(data));
  const config = await readProfile();
  const reader = connectLedger(
    config.ledgerUrl,
    await readToken(readerTokenFile),
  );
  const [end, pruned] = await Promise.all([
    ledgerEnd(reader),
    pruningOffset(reader),
  ]);
  try {
    await readTransactions(reader, fixture.bob, pruned, end, 1, true);
    throw new Error(
      "Expected Canton to reject Alice’s token when explicitly requesting Bob’s history.",
    );
  } catch (error) {
    if (!(error instanceof LedgerError) || error.status !== 403) throw error;
  }

  try {
    const update = await getTransaction(
      reader,
      config.sender,
      fixture.updateId,
    );
    if (update)
      throw new Error("Alice’s token can see the known Bob-only transaction.");
  } catch (error) {
    if (!(error instanceof LedgerError) || error.status !== 404) throw error;
  }
  console.log(
    "Canton rejected the Bob history filter and hid a known Bob-only update from Alice.",
  );
}

async function setup() {
  const secret = process.env.CANTON_PAYMENT_LOCAL_SECRET?.trim();
  if (!secret)
    throw new Error("Start LocalNet with npm run payments:localnet -- up.");
  if (await readOptional(configFile)) {
    const config = localProfileSchema.parse(await readProfileDocument());
    if (config.ledgerUrl !== ledgerUrl) {
      throw new Error(
        "Use a separate CANTON_PAYMENT_DIRECTORY for the LocalNet demo.",
      );
    }
    // The fixture identifies profiles created by this demo before credentials are refreshed.
    if (!(await readOptional(fixtureFile)))
      throw new Error("This profile was not created by the LocalNet demo.");
    await replaceFile(readerTokenFile, localToken(config.readerUser, secret));
    await replaceFile(signerTokenFile, localToken(config.signerUser, secret));
    await checkPartyIsolation();
    console.log("The LocalNet payment demo is already set up.");
    return;
  }
  if (await readOptional(signerKeyFile)) {
    throw new Error(
      "A previous setup did not finish. See the README for resetting the demo.",
    );
  }
  const ledger = connectLedger(ledgerUrl, localToken(adminUser, secret));
  const auth = {
    method: "static" as const,
    token: localToken(adminUser, secret),
  };
  const connected = z
    .object({
      connectedSynchronizers: z
        .array(z.object({ synchronizerId: z.string() }))
        .length(1),
    })
    .parse(await ledger("/v2/state/connected-synchronizers"));
  const synchronizer = connected.connectedSynchronizers[0].synchronizerId;
  const sdk = await SDK.create({
    auth,
    ledgerClientUrl: ledgerUrl,
    synchronizerId: synchronizer,
    token: { validatorUrl, registries: [registryUrl], auth },
    amulet: { validatorUrl, scanApiUrl, registryUrl, auth },
  });
  const tags = randomBytes(4).toString("hex");
  const readerUser = `mcp-payment-reader-${tags}`;
  const signerUser = `mcp-payment-signer-${tags}`;
  const aliceKeys = sdk.keys.generate();
  const bobKeys = sdk.keys.generate();
  const alice = (
    await sdk.party.external
      .create(aliceKeys.publicKey, { partyHint: `alice-${tags}` })
      .sign(aliceKeys.privateKey)
      .execute()
  ).partyId;
  const bob = (
    await sdk.party.external
      .create(bobKeys.publicKey, { partyHint: `bob-${tags}` })
      .sign(bobKeys.privateKey)
      .execute()
  ).partyId;
  const dso = await fetch(`${scanApiUrl}/v0/dso`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!dso.ok)
    throw new Error(
      `Could not discover the LocalNet DSO party (HTTP ${dso.status}).`,
    );
  const { dso_party_id: instrumentAdmin, amulet_rules } = z
    .object({
      dso_party_id: z.string(),
      amulet_rules: z.object({
        contract: z.object({ template_id: z.string() }),
      }),
    })
    .parse(await dso.json());
  const instrumentPackageId = amulet_rules.contract.template_id.split(":")[0];

  await sdk.amulet.tapInternal("1000");
  const [aliceTap, aliceDisclosures] = await sdk.amulet.tap(alice, "100");
  await sdk.ledger
    .prepare({
      partyId: alice,
      commands: aliceTap,
      disclosedContracts: aliceDisclosures,
    })
    .sign(aliceKeys.privateKey)
    .execute({ partyId: alice });
  const [bobTap, bobDisclosures] = await sdk.amulet.tap(bob, "10");
  const bobOnly = await sdk.ledger
    .prepare({
      partyId: bob,
      commands: bobTap,
      disclosedContracts: bobDisclosures,
    })
    .sign(bobKeys.privateKey)
    .execute({ partyId: bob });
  const preapproval = await sdk.amulet.preapproval.command.create({
    parties: { receiver: bob },
  });
  await sdk.ledger
    .prepare({ partyId: bob, commands: preapproval })
    .sign(bobKeys.privateKey)
    .execute({ partyId: bob });
  if (
    !(await sdk.amulet.preapproval.fetchStatus(bob, {
      timeoutMs: 150_000,
      intervalMs: 3_000,
    }))
  ) {
    throw new Error("Bob’s transfer preapproval did not become visible.");
  }

  await sdk.user.create({
    userId: readerUser,
    primaryParty: alice,
    userRights: { readAs: [alice] },
  });
  await sdk.user.create({
    userId: signerUser,
    primaryParty: alice,
    userRights: { actAs: [alice] },
  });
  const config = localProfileSchema.parse({
    ledgerUrl,
    registryUrl,
    sender: alice,
    instrumentAdmin,
    instrumentPackageId,
    synchronizer,
    fingerprint: alice.split("::")[1],
    readerUser,
    signerUser,
  });
  await writeOnce(
    policyFile,
    JSON.stringify(
      {
        allowedAssets: [asset],
        allowedRecipients: [bob],
        maxAmount: "10",
        reviewSeconds: 300,
      },
      null,
      2,
    ),
  );
  await writeOnce(readerTokenFile, localToken(readerUser, secret));
  await writeOnce(signerTokenFile, localToken(signerUser, secret));
  await writeOnce(
    fixtureFile,
    JSON.stringify({ bob, updateId: bobOnly.updateId }),
  );
  await writeOnce(signerKeyFile, aliceKeys.privateKey);
  await writeOnce(configFile, JSON.stringify(config, null, 2));
  await checkPartyIsolation();
  console.log(`LocalNet is ready.\nAlice ${alice}\nBob   ${bob}`);
}

try {
  if (process.argv.includes("--check-privacy")) await checkPartyIsolation();
  else await setup();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
