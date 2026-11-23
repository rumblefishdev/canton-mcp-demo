import { z } from "zod";
import { readContract, type Ledger } from "../../shared/ledger.js";
import { partySchema, readPolicyDocument } from "../../shared/profile.js";

export const groupRequestAction = "accept_group_request";
export const groupRequestChoice = "GroupRequest_Accept";
export const splitwellModule = "Splice.Splitwell";
export const groupRequestInput = z.object({
  contract_id: z
    .string()
    .min(1)
    .max(512)
    .describe("Contract ID of the Splitwell group request."),
});
const policySchema = z.object({
  groupRequests: z
    .object({
      packageId: z.string().regex(/^[a-f0-9]{64}$/),
      allowedOwners: z.array(partySchema),
      reviewSeconds: z.number().int().min(1).max(900),
    })
    .optional(),
});
const groupSchema = z.object({
  owner: partySchema,
  provider: partySchema,
  dso: partySchema,
  members: z.array(partySchema),
  id: z.object({ unpack: z.string() }),
  acceptDuration: z.object({ microseconds: z.string().regex(/^\d+$/) }),
});

export async function assessGroupRequest(
  ledger: Ledger,
  sender: string,
  contractId: string,
) {
  const { groupRequests: policy } = policySchema.parse(
    await readPolicyDocument(),
  );
  if (!policy)
    return {
      reason: "Splitwell group approvals are disabled in this profile.",
    };
  const contract = await readContract(ledger, sender, contractId);
  if (
    !contract ||
    contract.templateId !==
      `${policy.packageId}:${splitwellModule}:GroupRequest`
  ) {
    return {
      reason:
        "No active Splitwell group request is visible to this party for that contract ID.",
    };
  }
  const { group } = z
    .object({ group: groupSchema })
    .parse(contract.createArgument);
  if (
    group.provider !== sender ||
    !policy.allowedOwners.includes(group.owner)
  ) {
    return {
      reason:
        "The party or group owner is outside the Splitwell approval policy.",
    };
  }
  return {
    reviewSeconds: policy.reviewSeconds,
    terms: {
      group,
      templateId: contract.templateId,
      synchronizerId: contract.synchronizerId,
    },
  };
}
