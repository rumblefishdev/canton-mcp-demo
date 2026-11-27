import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { findTransactionByHash, connectCompanionReader } from "./ledger.js";
import { readProfile, requireReaderSocket } from "./profile.js";
import { walletStatus } from "./wallet-status.js";
import {
  isLegacyProposalExpired,
  readConfirmation,
  readProposal,
  readWalletResult,
  readWalletReview,
  readWalletReviewStart,
  recordConfirmation,
  writeProposal,
} from "./proposals.js";

export async function connectReader(
  profile?: Awaited<ReturnType<typeof readProfile>>,
) {
  const config = profile ?? (await readProfile());
  const ledger = connectCompanionReader(requireReaderSocket());
  return { config, ledger };
}

export function result(value: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

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
    ) => Promise<string | undefined>;
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
      const reason = await action.assess(input, profile);
      const requestId = randomUUID();
      const base = {
        requestId,
        action: action.id,
        input,
        createdAt: new Date().toISOString(),
        party: profile.sender,
        synchronizer: profile.synchronizer,
        reviewMode: "wallet" as const,
      };
      if (reason !== undefined) {
        await writeProposal({
          ...base,
          kind: "policy_rejected",
          reason,
        });
        return result({
          request_id: requestId,
          status: "policy_rejected",
          reason,
        });
      }
      await writeProposal({ ...base, kind: "proposal" });
      const wallet = await walletStatus();
      if (wallet.status !== "connected")
        return result({ request_id: requestId, ...wallet });
      return result({
        request_id: requestId,
        status: "awaiting_review",
        review:
          "Open the review link from action_status when the wallet companion has picked up the proposal.",
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
  if (proposal.reviewMode !== "wallet")
    return { status: "wallet_approval_unavailable" };
  const walletResult = await readWalletResult(requestId);
  if (walletResult) return { status: walletResult.status };
  const wallet = await walletStatus();
  if (wallet.status !== "connected") return wallet;
  const review = await readWalletReview(requestId);
  if (review) {
    const { ledger } = await connectReader(config);
    const match = await findTransactionByHash(
      ledger,
      config.sender,
      review.preparedHash,
    );
    if (match?.commandId === requestId) {
      await recordConfirmation(requestId, match.updateId);
      return { status: "confirmed", update_id: match.updateId };
    }
  }
  if (isLegacyProposalExpired(proposal)) return { status: "expired" };
  if (review)
    return {
      status: "awaiting_wallet_approval",
      review_url: review.reviewUrl,
    };
  if (proposal.expiresAt !== undefined)
    return { status: "wallet_approval_unavailable" };
  return {
    status: (await readWalletReviewStart(requestId))
      ? "wallet_handoff_unconfirmed"
      : "awaiting_review",
  };
}
