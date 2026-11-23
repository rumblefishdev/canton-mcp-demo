import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { z } from "zod";
import {
  configFile,
  profileDirectory,
  readerTokenFile,
} from "../../dist/mcp/shared/profile.js";
import { readPolicy } from "../../dist/mcp/tools/payments/payment-rules.js";

const statusSchema = z.object({ status: z.string() });
const proposalSchema = statusSchema.extend({ request_id: z.uuid() });
const confirmationSchema = statusSchema.extend({ update_id: z.string() });
const contextSchema = z.object({
  sender: z.string(),
  asset: z.string(),
  allowedRecipients: z.array(z.string()).min(1),
});
const activitySchema = z.object({
  party: z.string(),
  updates: z.array(
    z.object({ update_id: z.string(), command_id: z.string().optional() }),
  ),
});
const groupProposalSchema = proposalSchema.extend({
  terms: z.object({
    group: z.object({
      owner: z.string(),
      provider: z.string(),
      id: z.object({ unpack: z.string() }),
    }),
  }),
});
const updateSchema = z.object({
  update_id: z.string(),
  events: z.array(
    z.object({
      type: z.string(),
      contractId: z.string(),
      templateId: z.string(),
      choice: z.string().optional(),
      outcome: z.string().optional(),
    }),
  ),
});

function review(id: string, decision: "approve" | "reject", display?: RegExp) {
  return new Promise<void>((resolve, reject) => {
    const signer = spawn(
      process.execPath,
      ["dist/demo/signer/review-action.js", id],
      {
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 70_000,
      },
    );
    signer.on("error", reject);
    let transcript = "";
    let answered = false;
    signer.stdout.on("data", (chunk) => {
      transcript += chunk;
      if (!answered && transcript.includes("Type approve or reject:")) {
        answered = true;
        signer.stdin.end(decision + "\n");
      }
    });
    signer.stderr.on("data", (chunk) => {
      transcript += chunk;
    });
    signer.on("close", (code) => {
      if (code === 0 && answered && (!display || display.test(transcript)))
        resolve();
      else
        reject(new Error(transcript || `The signer exited with code ${code}.`));
    });
  });
}

const env = Object.fromEntries(
  Object.entries(process.env).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  ),
);
async function seedGroupRequest() {
  const { stdout } = await promisify(execFile)("bash", [
    "demo/localnet/network.sh",
    "seed-group",
  ]);
  return z.object({ contract_id: z.string() }).parse(JSON.parse(stdout));
}

const groupRequest = process.argv.includes("--group")
  ? await seedGroupRequest()
  : undefined;
const policy = await readPolicy();
const scratch = await mkdtemp(join(tmpdir(), "canton-payment-check-"));
const expiryPolicy = join(scratch, "short-policy.json");
const client = new Client(
  { name: "payment-flow-check", version: "1.0.0" },
  {
    versionNegotiation: { mode: { pin: "2026-07-28" } },
  },
);
async function call<T>(
  name: string,
  schema: z.ZodType<T>,
  args: Record<string, unknown> = {},
  session = client,
) {
  const result = await session.callTool({ name, arguments: args });
  assert.ok(!result.isError, JSON.stringify(result.content));
  return schema.parse(result.structuredContent);
}

async function checkGroupRequest(
  request: { contract_id: string },
  sender: string,
) {
  const declinedGroup = await call(
    "propose_accept_group_request",
    groupProposalSchema,
    request,
  );
  assert.equal(declinedGroup.status, "awaiting_review");
  assert.equal(declinedGroup.terms.group.provider, sender);
  assert.notEqual(declinedGroup.terms.group.owner, sender);
  await review(
    declinedGroup.request_id,
    "reject",
    /Splitwell group request acceptance/,
  );
  assert.equal(
    (
      await call("action_status", statusSchema, {
        request_id: declinedGroup.request_id,
      })
    ).status,
    "rejected",
  );

  const acceptedGroup = await call(
    "propose_accept_group_request",
    groupProposalSchema,
    request,
  );
  const duplicateGroup = await call(
    "propose_accept_group_request",
    groupProposalSchema,
    request,
  );
  assert.equal(acceptedGroup.status, "awaiting_review");
  assert.equal(
    (
      await call("payment_status", statusSchema, {
        request_id: acceptedGroup.request_id,
      })
    ).status,
    "unknown",
  );
  await review(
    acceptedGroup.request_id,
    "approve",
    /Splitwell group request acceptance/,
  );
  const confirmedGroup = await call("action_status", confirmationSchema, {
    request_id: acceptedGroup.request_id,
  });
  assert.equal(confirmedGroup.status, "confirmed");
  const groupUpdate = await call("get_activity", updateSchema, {
    update_id: confirmedGroup.update_id,
  });
  assert.ok(
    groupUpdate.events.some(
      (event) =>
        event.choice === "GroupRequest_Accept" &&
        event.contractId === request.contract_id,
    ),
  );
  assert.ok(
    groupUpdate.events.some(
      (event) =>
        event.type === "created" &&
        event.templateId.endsWith(":Splice.Splitwell:Group"),
    ),
  );
  assert.equal(
    (await call("propose_accept_group_request", statusSchema, request)).status,
    "policy_rejected",
  );
  await assert.rejects(
    review(duplicateGroup.request_id, "approve"),
    /No active Splitwell group request/,
  );
  return { requestId: acceptedGroup.request_id, confirmation: confirmedGroup };
}

try {
  const transport = process.argv.includes("--container")
    ? new StdioClientTransport({ command: "./demo/localnet/mcp.sh", env })
    : new StdioClientTransport({
        command: process.execPath,
        args: ["dist/mcp/index.js"],
        env,
      });
  await client.connect(transport);
  assert.equal(client.getProtocolEra(), "modern");
  const context = await call("payment_context", contextSchema);
  const payment = {
    recipient: context.allowedRecipients[0],
    amount: "2",
    asset: context.asset,
  };
  const before = await call("recent_activity", activitySchema);
  assert.equal(before.party, context.sender);
  assert.ok(before.updates.length > 0);

  const fixture = z
    .object({ updateId: z.string() })
    .parse(
      JSON.parse(
        await readFile(join(profileDirectory, "fixture.json"), "utf8"),
      ),
    );
  assert.equal(
    (await call("get_activity", statusSchema, { update_id: fixture.updateId }))
      .status,
    "not_visible",
  );
  assert.equal(
    (
      await call("propose_payment", statusSchema, {
        ...payment,
        amount: "1000000",
      })
    ).status,
    "policy_rejected",
  );

  const rejected = await call("propose_payment", proposalSchema, payment);
  assert.equal(rejected.status, "awaiting_review");
  await review(rejected.request_id, "reject");
  assert.equal(
    (
      await call("payment_status", statusSchema, {
        request_id: rejected.request_id,
      })
    ).status,
    "rejected",
  );

  const approved = await call("propose_payment", proposalSchema, payment);
  assert.equal(approved.status, "awaiting_review");
  await review(approved.request_id, "approve");
  const confirmed = await call("payment_status", confirmationSchema, {
    request_id: approved.request_id,
  });
  assert.equal(confirmed.status, "confirmed");
  const update = await call("get_activity", updateSchema, {
    update_id: confirmed.update_id,
  });
  assert.equal(update.update_id, confirmed.update_id);
  assert.ok(
    update.events.some(
      (event) =>
        event.choice === "TransferFactory_Transfer" &&
        event.outcome === "TransferInstructionResult_Completed",
    ),
  );

  const latest = await call("recent_activity", activitySchema);
  assert.ok(
    latest.updates.some(
      (transaction) => transaction.update_id === confirmed.update_id,
    ),
  );
  assert.ok(
    latest.updates.every(
      (transaction) => transaction.command_id !== rejected.request_id,
    ),
  );
  const group = groupRequest
    ? await checkGroupRequest(groupRequest, context.sender)
    : undefined;
  await client.close();

  await writeFile(
    expiryPolicy,
    JSON.stringify({ ...policy, reviewSeconds: 1 }),
  );
  const requestIds = group
    ? [approved.request_id, group.requestId]
    : [approved.request_id];
  await Promise.all(
    requestIds.map(async (id) => {
      const fixtureRequest = join(scratch, "requests", id);
      const approvedRequest = join(profileDirectory, "requests", id);
      await mkdir(fixtureRequest, { recursive: true, mode: 0o700 });
      await Promise.all(
        ["proposal.json", "decision.json"].map((file) =>
          copyFile(join(approvedRequest, file), join(fixtureRequest, file)),
        ),
      );
    }),
  );
  await Promise.all([
    copyFile(configFile, join(scratch, "config.json")),
    copyFile(readerTokenFile, join(scratch, "reader.jwt")),
  ]);
  // Keep the older on-disk payment record format readable across upgrades.
  const paymentRecord = join(
    scratch,
    "requests",
    approved.request_id,
    "proposal.json",
  );
  const {
    requestId,
    createdAt,
    expiresAt,
    input: transfer,
  } = JSON.parse(await readFile(paymentRecord, "utf8"));
  await writeFile(
    paymentRecord,
    JSON.stringify({
      kind: "proposal",
      requestId,
      createdAt,
      expiresAt,
      transfer,
    }),
  );
  // The recovery check also exercises the older initialize handshake used by legacy clients.
  const restarted = new Client({
    name: "payment-recovery-check",
    version: "1.0.0",
  });
  try {
    await restarted.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ["dist/mcp/server.js"],
        env: {
          ...env,
          CANTON_PAYMENT_DIRECTORY: scratch,
          CANTON_PAYMENT_POLICY: expiryPolicy,
          CANTON_PAYMENT_READER_TOKEN_FILE: join(scratch, "reader.jwt"),
        },
      }),
    );
    assert.equal(restarted.getProtocolEra(), "legacy");
    // Recreate the case where Canton confirmed the payment but the signer failed to save the response.
    const recovered = await call(
      "payment_status",
      confirmationSchema,
      { request_id: approved.request_id },
      restarted,
    );
    assert.deepEqual(recovered, confirmed);
    if (group) {
      const recoveredGroup = await call(
        "action_status",
        confirmationSchema,
        { request_id: group.requestId },
        restarted,
      );
      assert.deepEqual(recoveredGroup, group.confirmation);
    }
    const proposed = await call(
      "propose_payment",
      proposalSchema,
      payment,
      restarted,
    );
    assert.equal(proposed.status, "awaiting_review");
    await delay(1_100);
    const status = await call(
      "payment_status",
      statusSchema,
      { request_id: proposed.request_id },
      restarted,
    );
    assert.equal(status.status, "expired");
  } finally {
    await restarted.close();
  }
  const workflow = group ? "payment and Splitwell acceptance" : "payment";
  console.log(
    `Verified LocalNet ${workflow}, history, policy denial, rejection, expiry, privacy, and confirmation recovery.`,
  );
} finally {
  await client.close();
  await rm(scratch, { recursive: true, force: true });
}
