import { z } from "zod";
import {
  partySchema,
  profileFields,
  readProfileDocument,
} from "../../../dist/mcp/shared/profile.js";

const walletPaymentConfig = z.object({
  ...profileFields,
  synchronizer: z.string().min(1),
  registryUrl: z.url(),
  instrumentAdmin: partySchema,
  instrumentPackageId: z.string().regex(/^[a-f0-9]{64}$/),
});
export type WalletPaymentConfig = z.infer<typeof walletPaymentConfig>;

export async function readWalletPaymentConfig() {
  return walletPaymentConfig.parse(await readProfileDocument());
}
