import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const profileDirectory =
  process.env.CANTON_MCP_PROFILE_DIR ??
  process.env.CANTON_PAYMENT_DIRECTORY ??
  fileURLToPath(new URL("../../../.localnet/wallet-profile/", import.meta.url));

export const partySchema = z.string().regex(/^[a-zA-Z0-9:_\-]+::[a-f0-9]+$/);
export const profileFields = {
  ledgerUrl: z.url(),
  sender: partySchema,
  synchronizer: z.string().min(1).optional(),
};
const configSchema = z.object(profileFields);

export const configFile = join(profileDirectory, "config.json");
export const policyFile =
  process.env.CANTON_MCP_POLICY_FILE ??
  process.env.CANTON_PAYMENT_POLICY ??
  join(profileDirectory, "policy.json");

export async function readProfileDocument() {
  const data = z
    .looseObject({})
    .parse(JSON.parse(await readFile(configFile, "utf8")));
  // Profiles created by the earlier LocalNet demo use `alice` for the sender.
  return { ...data, sender: data.sender ?? data.alice };
}

export async function readProfile() {
  return configSchema.parse(await readProfileDocument());
}

export async function readPolicyDocument(): Promise<unknown> {
  return JSON.parse(await readFile(policyFile, "utf8"));
}

export function requireReaderSocket() {
  const socket = process.env.CANTON_MCP_WALLET_READER_SOCKET;
  if (!socket)
    throw new Error(
      "Set CANTON_MCP_WALLET_READER_SOCKET to the companion's ledger reader socket.",
    );
  return socket;
}
