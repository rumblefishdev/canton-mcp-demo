// Reference Wallet Gateway additions to the remote CIP-0103 dApp API.
import { request as requestHttp, type IncomingMessage } from "node:http";
import { request as requestHttps } from "node:https";
import { z } from "zod";
import { createCip0103Provider, WalletRpcError, walletRpc } from "./cip0103.js";

export const gatewaySessionConfig = z.object({
  dappUrl: z.url(),
  userApiUrl: z.url(),
  networkId: z.string().min(1),
});

type GatewayConfig = z.infer<typeof gatewaySessionConfig>;

const gatewayTransaction = z.object({
  id: z.uuid(),
  commandId: z.string(),
  status: z.enum([
    "pending",
    "awaiting-signature",
    "signed",
    "executed",
    "failed",
    "rejected",
  ]),
  preparedTransaction: z.string().min(1),
  preparedTransactionHash: z.string().min(1),
});

async function* gatewayEvents(
  endpoint: string,
  token: string,
  signal: AbortSignal,
) {
  const url = new URL(endpoint);
  url.pathname = url.pathname.replace(/\/$/, "") + "/events";
  const request = url.protocol === "https:" ? requestHttps : requestHttp;
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    request(
      url,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "text/event-stream",
        },
        agent: false,
        signal,
      },
      resolve,
    )
      .once("error", reject)
      .end();
  });
  if (
    response.statusCode !== 200 ||
    !response.headers["content-type"]?.startsWith("text/event-stream")
  ) {
    response.destroy();
    return;
  }
  const close = () => response.destroy();
  signal.addEventListener("abort", close, { once: true });
  if (signal.aborted) close();
  response.setEncoding("utf8");
  let buffer = "";
  try {
    for await (const chunk of response) {
      buffer += chunk;
      let match: RegExpExecArray | null;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const lines = buffer.slice(0, match.index).split(/\r?\n/);
        buffer = buffer.slice(match.index + match[0].length);
        if (!lines.some((line) => line.trimEnd() === "event: txChanged"))
          continue;
        const data = lines
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }
        yield Array.isArray(parsed) ? parsed[0] : parsed;
      }
      if (buffer.length > 1_000_000) return;
    }
  } finally {
    signal.removeEventListener("abort", close);
    close();
  }
}

export function createGatewayProvider(config: GatewayConfig, token?: string) {
  const { dappUrl, userApiUrl, networkId } = gatewaySessionConfig.parse(config);
  const request = walletRpc(dappUrl, token);
  return createCip0103Provider(
    async (method, params) => {
      try {
        return await request(method, params);
      } catch (error) {
        // Gateway 1.14 uses an internal RPC error for these Ledger API 404s.
        if (
          method === "ledgerApi" &&
          error instanceof WalletRpcError &&
          error.message === "Update not found, or not visible."
        )
          throw new WalletRpcError(-32001, error.message);
        throw error;
      }
    },
    { networkId, userOrigins: [new URL(userApiUrl).origin] },
    token ? (signal) => gatewayEvents(dappUrl, token, signal) : undefined,
  );
}

export function gatewayApprovalReference(url: URL, commandId: string) {
  if (url.searchParams.get("commandId") !== commandId)
    throw new Error("The Gateway returned an unexpected approval URL.");
  return z.uuid().parse(url.searchParams.get("transactionId"));
}

export function createGatewayInspector(config: GatewayConfig, token: string) {
  const user = walletRpc(config.userApiUrl, token);

  async function readTransaction(reference: string, commandId: string) {
    const transactionId = z.uuid().parse(reference);
    const result = gatewayTransaction.parse(
      await user("getTransaction", { transactionId }),
    );
    if (result.id !== transactionId || result.commandId !== commandId)
      throw new Error("The wallet transaction does not match the proposal.");
    return result;
  }

  return {
    async inspectApproval(approval: URL, commandId: string) {
      const reference = gatewayApprovalReference(approval, commandId);
      const transaction = await readTransaction(reference, commandId);
      if (transaction.status !== "pending")
        throw new Error(
          "The Gateway did not wait for approval. Use an interactive wallet user session.",
        );
      return { reference, ...transaction };
    },

    async reviewStatus(reference: string, commandId: string) {
      try {
        const transaction = await readTransaction(reference, commandId);
        return {
          status: transaction.status,
          preparedHash: transaction.preparedTransactionHash,
        };
      } catch (error) {
        if (
          !(error instanceof WalletRpcError) ||
          !error.message.includes(`Transaction not found with id: ${reference}`)
        )
          throw error;
        return { status: "removed" as const };
      }
    },
  };
}
