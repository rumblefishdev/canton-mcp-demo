import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { signTransactionHash } from "@canton-network/wallet-sdk";
import { z } from "zod";
import {
  readDecision,
  readProposal,
  recordConfirmation,
  writeDecision,
  writeUnconfirmed,
} from "../../../dist/mcp/shared/proposals.js";
import { readToken } from "../../../dist/mcp/shared/profile.js";
import { connectLedger } from "../../../dist/mcp/shared/ledger.js";
import { readSignerConfig, signerKeyFile, signerTokenFile } from "./config.js";
import {
  hashingSchemeVersion,
  preparedSchema,
  verifyPrepared,
} from "./prepared.js";
import { reviewers } from "./reviewers.js";

async function review(requestId: string) {
  const proposal = await readProposal(requestId);
  if (
    proposal?.kind !== "proposal" ||
    proposal.requestId !== requestId ||
    (await readDecision(requestId))
  ) {
    throw new Error("This request is unavailable for review.");
  }
  const { createdAt, expiresAt } = proposal;
  const reviewer = reviewers.get(proposal.action);
  if (!reviewer) throw new Error("This action has no registered signer.");
  const config = await readSignerConfig();
  if (
    (proposal.party && proposal.party !== config.sender) ||
    (proposal.synchronizer && proposal.synchronizer !== config.synchronizer)
  ) {
    throw new Error("The proposal belongs to another party or synchronizer.");
  }
  const token = await readToken(signerTokenFile);
  const ledger = connectLedger(config.ledgerUrl, token);
  const context = { proposal, config, token, ledger };

  const checkDeadline = () => {
    if (Date.parse(expiresAt) <= Date.now())
      throw new Error("This proposal expired.");
  };
  const enforceCurrentPolicy = async () => {
    checkDeadline();
    const reviewSeconds = await reviewer.checkPolicy(context);
    if (
      Date.parse(createdAt) > Date.now() ||
      Date.parse(expiresAt) <= Date.parse(createdAt) ||
      Date.parse(expiresAt) > Date.parse(createdAt) + reviewSeconds * 1_000
    ) {
      throw new Error("The proposal deadline exceeds the action policy.");
    }
    checkDeadline();
  };
  await enforceCurrentPolicy();

  const plan = await reviewer.plan(context);
  const prepared = preparedSchema.parse(
    await ledger("/v2/interactive-submission/prepare", {
      userId: config.signerUser,
      commandId: requestId,
      actAs: [config.sender],
      synchronizerId: config.synchronizer,
      maxRecordTime: expiresAt,
      hashingSchemeVersion,
      packageIdSelectionPreference: [],
      commands: plan.commands,
      disclosedContracts: plan.disclosedContracts,
    }),
  );
  const verified = await verifyPrepared(prepared, config, requestId, expiresAt);
  const [title, ...details] = plan.verify(verified);
  checkDeadline();
  console.log(
    [
      `${title} · ${requestId}`,
      ...details,
      `Hash   ${Buffer.from(verified.hash, "base64").toString("hex")}`,
    ].join("\n"),
  );

  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const answer = await prompt
    .question("Type approve or reject: ")
    .finally(() => prompt.close());
  const decision = answer.trim().toLowerCase();
  if (decision !== "approve" && decision !== "reject")
    throw new Error("No decision recorded.");
  if (decision === "reject") {
    await writeDecision(requestId, {
      decision,
      recordedAt: new Date().toISOString(),
      preparedHash: verified.hash,
    });
    console.log("Rejected.");
    return;
  }

  await enforceCurrentPolicy();
  const privateKey = await readFile(signerKeyFile, "utf8");
  checkDeadline();
  await writeDecision(requestId, {
    decision,
    recordedAt: new Date().toISOString(),
    preparedHash: verified.hash,
  });
  try {
    const response = z.object({ updateId: z.string().min(1) }).parse(
      await ledger("/v2/interactive-submission/executeAndWait", {
        userId: config.signerUser,
        submissionId: requestId,
        preparedTransaction: prepared.preparedTransaction,
        hashingSchemeVersion,
        deduplicationPeriod: {
          DeduplicationDuration: { value: { seconds: 600, nanos: 0 } },
        },
        partySignatures: {
          signatures: [
            {
              party: config.sender,
              signatures: [
                {
                  signature: signTransactionHash(
                    verified.hash,
                    privateKey.trim(),
                  ),
                  signedBy: config.fingerprint,
                  format: "SIGNATURE_FORMAT_CONCAT",
                  signingAlgorithmSpec: "SIGNING_ALGORITHM_SPEC_ED25519",
                },
              ],
            },
          ],
        },
      }),
    );
    await recordConfirmation(requestId, response.updateId);
    console.log(`Canton confirmed ledger update ${response.updateId}`);
  } catch (error) {
    await writeUnconfirmed(requestId);
    throw new Error(
      `Submission is unconfirmed. Check action_status with ${requestId}. ${String(error)}`,
    );
  }
}

const [requestId] = process.argv.slice(2);
try {
  if (!requestId)
    throw new Error("Usage: npm run actions:review -- REQUEST_ID");
  await review(requestId);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
