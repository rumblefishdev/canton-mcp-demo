import { z } from "zod";
import { connectCompanionReader } from "./ledger.js";
import { requireReaderSocket } from "./profile.js";

const walletStatusSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("connected"), party: z.string() }),
  z.object({
    status: z.literal("wallet_connection_required"),
    connection_url: z.url(),
  }),
  z.object({
    status: z.literal("wallet_connection_problem"),
    connection_url: z.url(),
    message: z.string(),
  }),
]);

export async function walletStatus() {
  try {
    const reader = connectCompanionReader(requireReaderSocket());
    return walletStatusSchema.parse(await reader("/wallet/status"));
  } catch {
    return {
      status: "wallet_companion_unavailable" as const,
      message: "Start the wallet companion and check its socket configuration.",
    };
  }
}
