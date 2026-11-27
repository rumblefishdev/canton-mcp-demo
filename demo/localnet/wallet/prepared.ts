import { timingSafeEqual } from "node:crypto";
import { PreparedTransaction } from "@canton-network/core-ledger-proto";
import { computePreparedTransactionHash } from "@canton-network/core-tx-hashing";
import { z } from "zod";
import type { WalletPaymentConfig } from "./config.js";

export const hashingSchemeVersion = "HASHING_SCHEME_VERSION_V3";
export const preparedSchema = z.object({
  preparedTransaction: z.string().min(1),
  preparedTransactionHash: z.string().min(1),
  hashingSchemeVersion: z.literal(hashingSchemeVersion),
});

export async function verifyPrepared(
  prepared: z.infer<typeof preparedSchema>,
  config: Pick<WalletPaymentConfig, "sender" | "synchronizer">,
  commandId: string,
) {
  const hash = await computePreparedTransactionHash(
    prepared.preparedTransaction,
    prepared.hashingSchemeVersion,
  );
  const claimed = Buffer.from(prepared.preparedTransactionHash, "base64");
  if (hash.length !== claimed.length || !timingSafeEqual(hash, claimed)) {
    throw new Error("The prepared transaction hash did not match.");
  }

  const { transaction, metadata } = PreparedTransaction.fromBinary(
    Buffer.from(prepared.preparedTransaction, "base64"),
  );
  const submitter = metadata?.submitterInfo;
  if (
    !transaction?.roots.length ||
    submitter?.commandId !== commandId ||
    submitter.actAs.length !== 1 ||
    submitter.actAs[0] !== config.sender ||
    metadata?.synchronizerId.split("::").slice(0, 2).join("::") !==
      config.synchronizer
  ) {
    throw new Error(
      "The prepared transaction does not match the requested action, party or network.",
    );
  }

  return {
    hash: Buffer.from(hash).toString("base64"),
    roots: transaction.roots,
    nodes: transaction.nodes,
  };
}

export type VerifiedTransaction = Awaited<ReturnType<typeof verifyPrepared>>;

export function singleRootExercise({ roots, nodes }: VerifiedTransaction) {
  const node = nodes.find((item) => item.nodeId === roots[0])?.versionedNode;
  const root = node?.oneofKind === "v1" ? node.v1.nodeType : undefined;
  if (roots.length !== 1 || root?.oneofKind !== "exercise") {
    throw new Error(
      "The prepared transaction must contain a single root exercise.",
    );
  }
  return root.exercise;
}
