import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const profileDirectory =
  process.env.CANTON_PAYMENT_DIRECTORY ??
  fileURLToPath(new URL("../../../.payments/", import.meta.url));

export const partySchema = z.string().regex(/^[a-zA-Z0-9:_\-]+::[a-f0-9]+$/);
export const profileFields = {
  ledgerUrl: z.url(),
  sender: partySchema,
  synchronizer: z.string().min(1).optional(),
};
const configSchema = z.object(profileFields);

export const configFile = join(profileDirectory, "config.json");
export const policyFile =
  process.env.CANTON_PAYMENT_POLICY ?? join(profileDirectory, "policy.json");

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

export async function readToken(path: string) {
  const token = (await readFile(path, "utf8")).trim();
  if (!token) throw new Error("The Canton Ledger API token file is empty.");
  return token;
}

export const readerTokenFile =
  process.env.CANTON_PAYMENT_READER_TOKEN_FILE ??
  join(profileDirectory, "reader.jwt");
