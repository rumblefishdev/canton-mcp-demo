import { z } from "zod";
import { partySchema, readPolicyDocument } from "../../shared/profile.js";

export const asset = "CC";
export const cantonInstrumentId = "Amulet";
export const amountSchema = z
  .string()
  .regex(/^(0|[1-9]\d{0,17})(\.\d{1,10})?$/)
  .refine((value) => /[1-9]/.test(value), "Amount must be positive.");
export function amountUnits(amount: string) {
  const [whole, fraction = ""] = amountSchema.parse(amount).split(".");
  return BigInt(whole + fraction.padEnd(10, "0"));
}

export const policySchema = z.object({
  allowedAssets: z.array(z.literal(asset)),
  allowedRecipients: z.array(partySchema),
  maxAmount: amountSchema,
});

export async function readPolicy() {
  const document = z.looseObject({}).parse(await readPolicyDocument());
  return policySchema.parse({
    ...document,
    allowedAssets: Array.isArray(document.allowedAssets)
      ? document.allowedAssets.map((value) =>
          value === cantonInstrumentId ? asset : value,
        )
      : document.allowedAssets,
  });
}

export const transferSchema = z.object({
  recipient: partySchema.describe("Canton party ID of the recipient."),
  amount: amountSchema.describe(
    "Positive transfer amount as a decimal string.",
  ),
  asset: z.literal(asset).describe("Asset to transfer, expressed as CC."),
});
export type Transfer = z.infer<typeof transferSchema>;

export function checkPolicy(
  transfer: Transfer,
  policy: z.infer<typeof policySchema>,
) {
  if (!policy.allowedAssets.includes(transfer.asset))
    return "The asset is outside the payment policy.";
  if (!policy.allowedRecipients.includes(transfer.recipient))
    return "The recipient is outside the payment policy.";
  if (amountUnits(transfer.amount) > amountUnits(policy.maxAmount))
    return "The amount exceeds the payment policy limit.";
  return undefined;
}
