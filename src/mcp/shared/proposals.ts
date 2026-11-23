import { join } from "node:path";
import { z } from "zod";
import { readOptional, requestIdSchema, writeOnce } from "./files.js";
import { partySchema, profileDirectory } from "./profile.js";

const baseRequest = z.object({
  requestId: requestIdSchema,
  createdAt: z.iso.datetime(),
  action: z.string().min(1),
  input: z.unknown(),
  terms: z.record(z.string(), z.unknown()).optional(),
  party: partySchema.optional(),
  synchronizer: z.string().min(1).optional(),
});

const proposalSchema = z.discriminatedUnion("kind", [
  baseRequest.extend({
    kind: z.literal("proposal"),
    expiresAt: z.iso.datetime(),
  }),
  baseRequest.extend({
    kind: z.literal("policy_rejected"),
    reason: z.string(),
  }),
]);
const decisionSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  recordedAt: z.iso.datetime(),
  preparedHash: z.string(),
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
export const readDecision = (id: string) =>
  readEvent(id, "decision", decisionSchema);
export const readConfirmation = (id: string) =>
  readEvent(id, "confirmation", confirmationSchema);
export const readUnconfirmed = (id: string) =>
  readEvent(id, "submission-unconfirmed", failureSchema);

export const writeProposal = (proposal: z.infer<typeof proposalSchema>) =>
  writeOnce(
    eventFile(proposal.requestId, "proposal"),
    JSON.stringify(proposal),
  );
export const writeDecision = (
  id: string,
  decision: z.infer<typeof decisionSchema>,
) => writeOnce(eventFile(id, "decision"), JSON.stringify(decision));
export const writeUnconfirmed = (id: string) =>
  writeOnce(
    eventFile(id, "submission-unconfirmed"),
    JSON.stringify({ recordedAt: new Date().toISOString() }),
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
