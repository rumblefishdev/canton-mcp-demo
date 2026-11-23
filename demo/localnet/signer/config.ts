import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  partySchema,
  profileFields,
  readProfileDocument,
} from "../../../dist/mcp/shared/profile.js";

export const signerProfileFields = {
  synchronizer: z.string().min(1),
  fingerprint: z.string().min(1),
  signerUser: z.string().min(1),
};
export const paymentSignerFields = {
  registryUrl: z.url(),
  instrumentAdmin: partySchema,
  instrumentPackageId: z.string().regex(/^[a-f0-9]{64}$/),
};
const signerConfigSchema = z.object({
  ...profileFields,
  ...signerProfileFields,
});
const paymentSignerConfigSchema =
  signerConfigSchema.extend(paymentSignerFields);
export type SignerConfig = z.infer<typeof signerConfigSchema>;
export type PaymentSignerConfig = z.infer<typeof paymentSignerConfigSchema>;

export async function readSignerConfig() {
  return signerConfigSchema.parse(await readProfileDocument());
}

export async function readPaymentSignerConfig() {
  return paymentSignerConfigSchema.parse(await readProfileDocument());
}

const signerDirectory =
  process.env.CANTON_PAYMENT_SIGNER_DIRECTORY ??
  fileURLToPath(new URL("../../../.payment-signer/", import.meta.url));

export const signerTokenFile =
  process.env.CANTON_PAYMENT_SIGNER_TOKEN_FILE ??
  join(signerDirectory, "signer.jwt");
export const signerKeyFile = join(signerDirectory, "alice.key");
