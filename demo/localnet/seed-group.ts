import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { SDK } from "@canton-network/wallet-sdk";
import { z } from "zod";
import { replaceFile } from "../../dist/mcp/shared/files.js";
import {
  groupRequestChoice,
  splitwellModule,
} from "../../dist/mcp/tools/splitwell/group-request.js";
import {
  getTransaction,
  connectLedger,
  readContract,
} from "../../dist/mcp/shared/ledger.js";
import {
  partySchema,
  policyFile,
  readPolicyDocument,
  readerTokenFile,
  readToken,
} from "../../dist/mcp/shared/profile.js";
import { adminUser, localToken } from "./auth.js";
import {
  readPaymentSignerConfig,
  signerKeyFile,
  signerTokenFile,
} from "./signer/config.js";

// Main package of splitwell-current.dar in the pinned Splice 0.9.4 release.
const packageId =
  "f68e135ff248a3733602c92ee90f5508e22e0d129bc0d21501e5045b28102d81";
const template = (name: string) => `${packageId}:${splitwellModule}:${name}`;

async function seedGroup() {
  const secret = process.env.CANTON_PAYMENT_LOCAL_SECRET;
  const darPath = process.env.CANTON_LOCALNET_SPLITWELL_DAR;
  if (!secret || !darPath)
    throw new Error("Run npm run actions:seed-group after starting LocalNet.");
  const config = await readPaymentSignerConfig();
  if (config.ledgerUrl !== "http://127.0.0.1:2975/")
    throw new Error("The group seeder requires the LocalNet profile.");

  const adminToken = localToken(adminUser, secret);
  const adminLedger = connectLedger(config.ledgerUrl, adminToken);
  const {
    user: { primaryParty: owner },
  } = z
    .object({ user: z.object({ primaryParty: partySchema }) })
    .parse(await adminLedger(`/v2/users/${adminUser}`));

  const policy = z
    .looseObject({
      groupRequests: z
        .object({
          packageId: z.literal(packageId),
          allowedOwners: z.array(partySchema),
        })
        .optional(),
    })
    .parse(await readPolicyDocument());
  if (
    policy.groupRequests &&
    !policy.groupRequests.allowedOwners.includes(owner)
  ) {
    throw new Error(
      "The LocalNet group owner is outside your configured Splitwell policy.",
    );
  }

  const { packageIds } = z
    .object({ packageIds: z.array(z.string()) })
    .parse(await adminLedger("/v2/packages"));
  if (!packageIds.includes(packageId)) {
    const upload = await fetch(
      new URL("/v2/dars?vetAllPackages=true", config.ledgerUrl),
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/octet-stream",
        },
        body: new Uint8Array(await readFile(darPath)),
        redirect: "error",
        signal: AbortSignal.timeout(90_000),
      },
    );
    if (!upload.ok)
      throw new Error(
        `Splitwell DAR upload failed (HTTP ${upload.status}): ${(await upload.text()).slice(0, 500)}`,
      );
  }

  const signerToken = await readToken(signerTokenFile);
  const reader = connectLedger(
    config.ledgerUrl,
    await readToken(readerTokenFile),
  );
  const sdk = await SDK.create({
    auth: { method: "static", token: signerToken },
    ledgerClientUrl: config.ledgerUrl,
    synchronizerId: config.synchronizer,
  });
  // Creating the provider rules is demo provisioning. Alice approves real requests through the review CLI.
  const { updateId } = await sdk.ledger
    .prepare({
      partyId: config.sender,
      commands: {
        CreateCommand: {
          templateId: template("SplitwellRules"),
          createArguments: { provider: config.sender },
        },
      },
    })
    .sign((await readFile(signerKeyFile, "utf8")).trim())
    .execute({ partyId: config.sender });
  const update = await getTransaction(reader, config.sender, updateId);
  const rulesEvent = update?.events.find(
    (event) =>
      "CreatedEvent" in event &&
      event.CreatedEvent.templateId === template("SplitwellRules"),
  );
  if (!rulesEvent || !("CreatedEvent" in rulesEvent))
    throw new Error("Could not locate the created Splitwell rules.");
  const rules = await readContract(
    reader,
    config.sender,
    rulesEvent.CreatedEvent.contractId,
    true,
  );
  if (!rules?.createdEventBlob)
    throw new Error("No Splitwell rules disclosure was returned.");

  const groupName = `localnet-${randomUUID().slice(0, 8)}`;
  const request = await adminLedger(
    "/v2/commands/submit-and-wait-for-transaction",
    {
      commands: {
        userId: adminUser,
        commandId: randomUUID(),
        actAs: [owner],
        synchronizerId: config.synchronizer,
        disclosedContracts: [
          {
            contractId: rules.contractId,
            templateId: rules.templateId,
            createdEventBlob: rules.createdEventBlob,
            synchronizerId: rules.synchronizerId,
          },
        ],
        commands: [
          {
            ExerciseCommand: {
              templateId: rules.templateId,
              contractId: rules.contractId,
              choice: "SplitwellRules_RequestGroup",
              choiceArgument: {
                user: owner,
                group: {
                  owner,
                  provider: config.sender,
                  dso: config.instrumentAdmin,
                  members: [],
                  id: { unpack: groupName },
                  acceptDuration: { microseconds: "600000000" },
                },
              },
            },
          },
        ],
      },
    },
  );
  const { transaction } = z
    .object({
      transaction: z.object({
        events: z.array(
          z.object({
            CreatedEvent: z
              .object({ templateId: z.string(), contractId: z.string() })
              .optional(),
          }),
        ),
      }),
    })
    .parse(request);
  const created = transaction.events.find(
    (event) => event.CreatedEvent?.templateId === template("GroupRequest"),
  )?.CreatedEvent;
  if (!created)
    throw new Error(
      `Could not locate the created group request for ${groupRequestChoice}.`,
    );
  if (!policy.groupRequests) {
    await replaceFile(
      policyFile,
      JSON.stringify(
        {
          ...policy,
          groupRequests: {
            packageId,
            allowedOwners: [owner],
            reviewSeconds: 300,
          },
        },
        null,
        2,
      ),
    );
  }
  console.log(JSON.stringify({ contract_id: created.contractId }));
}

try {
  await seedGroup();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
