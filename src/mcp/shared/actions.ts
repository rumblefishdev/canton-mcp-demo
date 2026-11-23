import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { findTransactionByHash, connectLedger } from "./ledger.js";
import { readProfile, readerTokenFile, readToken } from "./profile.js";
import {
  readConfirmation,
  readDecision,
  readProposal,
  readUnconfirmed,
  recordConfirmation,
  writeProposal,
} from "./proposals.js";

export async function connectReader(
  profile?: Awaited<ReturnType<typeof readProfile>>,
) {
  const config = profile ?? (await readProfile());
  const ledger = connectLedger(
    process.env.CANTON_PAYMENT_LEDGER_URL ?? config.ledgerUrl,
    await readToken(readerTokenFile),
  );
  return { config, ledger };
}

export function result(value: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

export type Assessment =
  | { reason: string }
  | { reviewSeconds: number; terms?: Record<string, unknown> };

export function registerAction<Input extends z.ZodRawShape>(
  server: McpServer,
  action: {
    id: string;
    tool: string;
    description: string;
    inputSchema: z.ZodObject<Input>;
    assess: (
      input: z.output<z.ZodObject<Input>>,
      profile: Awaited<ReturnType<typeof readProfile>>,
    ) => Promise<Assessment>;
  },
) {
  server.registerTool(
    action.tool,
    {
      description: action.description,
      inputSchema: action.inputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async (input) => {
      const profile = await readProfile();
      const assessment = await action.assess(input, profile);
      const createdAt = new Date();
      const requestId = randomUUID();
      const base = {
        requestId,
        action: action.id,
        input,
        createdAt: createdAt.toISOString(),
        party: profile.sender,
        synchronizer: profile.synchronizer,
      };
      if ("reason" in assessment) {
        await writeProposal({
          ...base,
          kind: "policy_rejected",
          reason: assessment.reason,
        });
        return result({
          request_id: requestId,
          status: "policy_rejected",
          reason: assessment.reason,
        });
      }
      const expiresAt = new Date(
        createdAt.getTime() + assessment.reviewSeconds * 1_000,
      ).toISOString();
      await writeProposal({
        ...base,
        kind: "proposal",
        expiresAt,
        ...(assessment.terms && { terms: assessment.terms }),
      });
      return result({
        request_id: requestId,
        status: "awaiting_review",
        expires_at: expiresAt,
        terms: assessment.terms,
        review: `Run npm run actions:review -- ${requestId} in the signer terminal.`,
      });
    },
  );
}

export async function actionStatus(requestId: string, action?: string) {
  const proposal = await readProposal(requestId);
  if (!proposal || (action !== undefined && action !== proposal.action))
    return { status: "unknown" };
  const config = await readProfile();
  if (
    (proposal.party && proposal.party !== config.sender) ||
    (proposal.synchronizer && proposal.synchronizer !== config.synchronizer)
  )
    return { status: "unknown" };
  if (proposal.kind === "policy_rejected")
    return { status: "policy_rejected", reason: proposal.reason };
  const confirmation = await readConfirmation(requestId);
  if (confirmation)
    return { status: "confirmed", update_id: confirmation.updateId };
  const decision = await readDecision(requestId);
  if (!decision) {
    return {
      status:
        Date.parse(proposal.expiresAt) <= Date.now()
          ? "expired"
          : "awaiting_review",
    };
  }
  if (decision.decision === "reject") return { status: "rejected" };

  const { ledger } = await connectReader(config);
  // The signer commits to the specific prepared transaction before attempting execution.
  const match = await findTransactionByHash(
    ledger,
    config.sender,
    decision.preparedHash,
  );
  if (match?.commandId === requestId) {
    await recordConfirmation(requestId, match.updateId);
    return { status: "confirmed", update_id: match.updateId };
  }
  return {
    status: (await readUnconfirmed(requestId))
      ? "submission_unconfirmed"
      : "approved_unconfirmed",
  };
}
