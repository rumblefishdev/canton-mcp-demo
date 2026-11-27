// Share party-scoped reads and manage verified wallet handoffs for MCP proposals.
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { startLedgerReader } from "../mcp/shared/ledger-reader.js";
import { findTransactionByHash, LedgerError } from "../mcp/shared/ledger.js";
import { profileDirectory } from "../mcp/shared/profile.js";
import {
  isLegacyProposalExpired,
  readConfirmation,
  readProposal,
  readWalletReview,
  readWalletReviewStart,
  readWalletResult,
  recordConfirmation,
  startWalletReview,
  writeWalletResult,
  writeWalletReview,
} from "../mcp/shared/proposals.js";
import type {
  Cip0103Provider,
  WalletCommands,
  WalletTransactionEvent,
} from "./cip0103.js";

export type PreparedApproval = {
  reference: string;
  preparedTransaction: string;
  preparedTransactionHash: string;
};

type VerifiedReviews = {
  plan(requestId: string): Promise<{
    commands: WalletCommands;
    verify(
      prepared: PreparedApproval,
    ): Promise<{ hash: string; details: string[] }>;
  }>;
  inspectApproval(approval: URL, commandId: string): Promise<PreparedApproval>;
  reviewStatus?(
    reference: string,
    commandId: string,
  ): Promise<{
    status:
      | "pending"
      | "awaiting-signature"
      | "signed"
      | "executed"
      | "failed"
      | "rejected"
      | "removed";
    preparedHash?: string;
  }>;
};

export type WalletSession = {
  provider: Cip0103Provider;
  verifiedReviews?: VerifiedReviews;
};

type CompanionOptions = {
  sender: string;
  socketPath: string;
  session(): WalletSession | undefined;
  connectionUrl: URL;
  connectionError?(): string | undefined;
  walletName?: string;
  presentApproval?(approval: URL): string;
  signal: AbortSignal;
};

async function review(
  requestId: string,
  session: WalletSession,
  options: CompanionOptions,
  onHandoff: () => void,
) {
  const { sender, signal, presentApproval } = options;
  const { provider, verifiedReviews } = session;
  if (!verifiedReviews) {
    await writeWalletResult(requestId, "wallet_approval_unavailable");
    return;
  }
  const proposal = await readProposal(requestId);
  if (
    proposal?.kind !== "proposal" ||
    proposal.reviewMode !== "wallet" ||
    proposal.party !== sender
  )
    return;
  await provider.verifyAccount(sender);

  const listener = new AbortController();
  const eventSignal = AbortSignal.any([signal, listener.signal]);
  let event: WalletTransactionEvent | undefined;
  const listen = async () => {
    for await (const update of provider.transactionEvents(
      requestId,
      eventSignal,
    ))
      event = update;
  };
  // The ledger and adapter status can recover a result if the event connection drops.
  const listening = listen().catch(() => {});

  try {
    let handoff = await readWalletReview(requestId);
    if (!handoff) {
      const plan = await verifiedReviews.plan(requestId);
      if (signal.aborted) return;
      await startWalletReview(requestId);
      const approval = await provider.requestApproval(
        requestId,
        sender,
        plan.commands,
      );
      const pending = await verifiedReviews.inspectApproval(
        approval,
        requestId,
      );
      const verified = await plan.verify(pending);
      handoff = {
        reference: pending.reference,
        reviewUrl: presentApproval?.(approval) ?? approval.href,
        preparedHash: verified.hash,
      };
      await writeWalletReview(requestId, handoff);
      console.log(verified.details.join("\n"));
    }
    onHandoff();
    console.log(`Review in wallet: ${handoff.reviewUrl}`);

    while (!signal.aborted && !isLegacyProposalExpired(proposal)) {
      const updateEvent = event;
      // Gateway status is a recovery path and preserves detailed rejection outcomes.
      const state =
        updateEvent?.status === "executed"
          ? undefined
          : await verifiedReviews.reviewStatus?.(handoff.reference, requestId);
      if (
        state?.preparedHash !== undefined &&
        state.preparedHash !== handoff.preparedHash
      )
        throw new Error("The wallet changed the prepared transaction.");
      const status = state?.status ?? updateEvent?.status;
      if (
        !state ||
        status === "executed" ||
        status === "failed" ||
        status === "removed"
      ) {
        const update = await findTransactionByHash(
          provider.ledger,
          sender,
          handoff.preparedHash,
        );
        if (
          update?.commandId === requestId &&
          (updateEvent?.status !== "executed" ||
            update.updateId === updateEvent.payload.updateId)
        ) {
          await recordConfirmation(requestId, update.updateId);
          console.log(`Canton confirmed ledger update ${update.updateId}.`);
          return;
        }
        if (updateEvent?.status === "executed" && event === updateEvent)
          event = undefined;
      }
      if (
        status === "failed" ||
        status === "removed" ||
        status === "rejected"
      ) {
        await writeWalletResult(
          requestId,
          status === "failed"
            ? "wallet_failed"
            : status === "removed"
              ? "wallet_request_removed"
              : "rejected",
        );
        return;
      }
      await delay(1000, undefined, { signal }).catch((error) => {
        if (!signal.aborted) throw error;
      });
    }
  } finally {
    listener.abort();
    await listening;
  }
}

async function watch(options: CompanionOptions) {
  const stop = new AbortController();
  const signal = AbortSignal.any([options.signal, stop.signal]);
  const requests = join(profileDirectory, "requests");
  const active = new Map<string, Promise<void>>();
  const preparing = new Set<string>();
  const retryAfter = new Map<string, number>();
  console.log("Watching for wallet proposals.");

  try {
    while (!signal.aborted) {
      const session = options.session();
      const entries = session
        ? await readdir(requests, { withFileTypes: true }).catch(
            (error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return [];
              throw error;
            },
          )
        : [];
      for (const [id, when] of retryAfter)
        if (when <= Date.now()) retryAfter.delete(id);
      for (const entry of entries) {
        if (!session || signal.aborted) break;
        const id = entry.name;
        if (
          !entry.isDirectory() ||
          !z.uuid().safeParse(id).success ||
          active.has(id) ||
          retryAfter.has(id)
        )
          continue;
        const proposal = await readProposal(id);
        if (
          proposal?.kind !== "proposal" ||
          proposal.reviewMode !== "wallet" ||
          proposal.party !== options.sender ||
          isLegacyProposalExpired(proposal)
        )
          continue;
        if ((await readConfirmation(id)) || (await readWalletResult(id)))
          continue;
        if (!(await readWalletReview(id))) {
          if (
            proposal.expiresAt !== undefined ||
            preparing.size >= 4 ||
            (await readWalletReviewStart(id))
          )
            continue;
          preparing.add(id);
        }
        active.set(
          id,
          review(id, session, { ...options, signal }, () =>
            preparing.delete(id),
          )
            .catch((error) => {
              if (signal.aborted) return;
              retryAfter.set(id, Date.now() + 10_000);
              console.error(
                `Wallet proposal ${id}: ${error instanceof Error ? error.message : String(error)}`,
              );
            })
            .finally(() => {
              preparing.delete(id);
              active.delete(id);
            }),
        );
      }
      await delay(1000, undefined, { signal });
    }
  } catch (error) {
    if (!signal.aborted) throw error;
  } finally {
    stop.abort();
    await Promise.all(active.values());
  }
}

export async function runWalletCompanion(options: CompanionOptions) {
  const reader = await startLedgerReader(
    options.socketPath,
    options.sender,
    async () => {
      try {
        const session = options.session();
        if (!session) throw new Error("Connect the wallet first.");
        await session.provider.verifyAccount(options.sender);
        return session.provider.ledger;
      } catch {
        throw new LedgerError(
          401,
          "/session",
          `Connect or reconnect ${options.walletName ?? "wallet"} at ${options.connectionUrl.href}`,
        );
      }
    },
    async () => {
      const session = options.session();
      if (!session) {
        const message = options.connectionError?.();
        if (message)
          return {
            status: "wallet_connection_problem",
            connection_url: options.connectionUrl.href,
            message,
          };
        return {
          status: "wallet_connection_required",
          connection_url: options.connectionUrl.href,
        };
      }
      try {
        await session.provider.verifyAccount(options.sender);
        await session.provider.ledger("/v2/state/ledger-end");
        return { status: "connected", party: options.sender };
      } catch {
        return {
          status: "wallet_connection_problem",
          connection_url: options.connectionUrl.href,
          message:
            "The wallet session could not verify the configured party and ledger access. Reconnect the wallet or check the provider.",
        };
      }
    },
  );
  try {
    await watch(options);
  } finally {
    reader.close();
  }
}
