import { join } from "node:path";
import { z } from "zod";
import { readOptional, requestIdSchema, writeOnce } from "./files.js";
import { partySchema, profileDirectory } from "./profile.js";

const baseRequest = z.object({
  requestId: requestIdSchema,
  createdAt: z.iso.datetime(),
  action: z.string().min(1),
  reviewMode: z.literal("wallet").optional(),
  input: z.unknown(),
  party: partySchema.optional(),
  synchronizer: z.string().min(1).optional(),
});

const proposalSchema = z.discriminatedUnion("kind", [
  baseRequest.extend({
    kind: z.literal("proposal"),
    // Older handoffs may already have a deadline signed into the transaction.
    expiresAt: z.iso.datetime().optional(),
  }),
  baseRequest.extend({
    kind: z.literal("policy_rejected"),
    reason: z.string(),
  }),
]);
const walletReviewSchema = z.object({
  reference: z.string().min(1),
  reviewUrl: z.url(),
  preparedHash: z.string().min(1),
});
const storedWalletReviewSchema = z.preprocess((data) => {
  if (
    typeof data !== "object" ||
    data === null ||
    "reference" in data ||
    !("transactionId" in data)
  )
    return data;
  return { ...data, reference: data.transactionId };
}, walletReviewSchema);
const walletResultSchema = z.object({
  status: z.enum([
    "rejected",
    "wallet_request_removed",
    "wallet_failed",
    "wallet_approval_unavailable",
  ]),
  recordedAt: z.iso.datetime(),
});
const confirmationSchema = z.object({
  updateId: z.string(),
  recordedAt: z.iso.datetime(),
});
const failureSchema = z.object({ recordedAt: z.iso.datetime() });

function eventFile(id: string, event: string) {
  return join(
    profileDirectory,
    "requests",
    requestIdSchema.parse(id),
    `${event}.json`,
  );
}

async function readEvent<T>(id: string, event: string, schema: z.ZodType<T>) {
  const data = await readOptional(eventFile(id, event));
  return data === undefined ? undefined : schema.parse(JSON.parse(data));
}

const storedProposalSchema = z.preprocess((data) => {
  if (
    typeof data !== "object" ||
    data === null ||
    "action" in data ||
    !("transfer" in data)
  )
    return data;
  return { ...data, action: "payment", input: data.transfer };
}, proposalSchema);

export const readProposal = (id: string) =>
  readEvent(id, "proposal", storedProposalSchema);
export type Proposal = Extract<
  z.infer<typeof proposalSchema>,
  { kind: "proposal" }
>;
export function isLegacyProposalExpired({ expiresAt }: Proposal) {
  return expiresAt !== undefined && Date.parse(expiresAt) <= Date.now();
}
export const readConfirmation = (id: string) =>
  readEvent(id, "confirmation", confirmationSchema);
export const writeProposal = (
  proposal:
    | Omit<Proposal, "expiresAt">
    | Extract<z.infer<typeof proposalSchema>, { kind: "policy_rejected" }>,
) =>
  writeOnce(
    eventFile(proposal.requestId, "proposal"),
    JSON.stringify(proposal),
  );
export async function recordConfirmation(id: string, updateId: string) {
  try {
    await writeOnce(
      eventFile(id, "confirmation"),
      JSON.stringify({ updateId, recordedAt: new Date().toISOString() }),
    );
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code !== "EEXIST" ||
      (await readConfirmation(id))?.updateId !== updateId
    ) {
      throw error;
    }
  }
}

export const startWalletReview = (id: string) =>
  writeOnce(
    eventFile(id, "wallet-started"),
    JSON.stringify({ recordedAt: new Date().toISOString() }),
  );
export const readWalletReviewStart = (id: string) =>
  readEvent(id, "wallet-started", failureSchema);
export const readWalletReview = (id: string) =>
  readEvent(id, "wallet-review", storedWalletReviewSchema);
export const writeWalletReview = (
  id: string,
  review: z.infer<typeof walletReviewSchema>,
) => writeOnce(eventFile(id, "wallet-review"), JSON.stringify(review));
export const readWalletResult = (id: string) =>
  readEvent(id, "wallet-result", walletResultSchema);
export const writeWalletResult = (
  id: string,
  status: z.infer<typeof walletResultSchema>["status"],
) =>
  writeOnce(
    eventFile(id, "wallet-result"),
    JSON.stringify({ status, recordedAt: new Date().toISOString() }),
  );
