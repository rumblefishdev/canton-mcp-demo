// The remote dApp API contracts used by the companion.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { LedgerError, type Ledger } from "../mcp/shared/ledger.js";

export class WalletRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

export type WalletRequest = (
  method: string,
  params?: object,
) => Promise<unknown>;

export function walletRpc(endpoint: string, token?: string): WalletRequest {
  return async (method, params) => {
    const id = randomUUID();
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token && { Authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      redirect: "error",
      signal: AbortSignal.timeout(35_000),
    });
    const parsed = z
      .object({
        jsonrpc: z.literal("2.0"),
        id: z.literal(id),
        result: z.unknown().optional(),
        error: z.object({ code: z.number(), message: z.string() }).optional(),
      })
      .safeParse(await response.json().catch(() => undefined));
    if (parsed.success && parsed.data.error)
      throw new WalletRpcError(
        parsed.data.error.code,
        parsed.data.error.message,
      );
    if (!response.ok || !parsed.success || !("result" in parsed.data))
      throw new Error(
        `Wallet returned an invalid RPC response (HTTP ${response.status}).`,
      );
    return parsed.data.result;
  };
}

export type WalletCommands = {
  commands: object[];
  disclosedContracts: object[];
};

const transactionEvent = z.discriminatedUnion("status", [
  z.object({
    status: z.enum(["pending", "signed", "failed"]),
    commandId: z.string(),
  }),
  z.object({
    status: z.literal("executed"),
    commandId: z.string(),
    payload: z.object({ updateId: z.string().min(1) }),
  }),
]);
export type WalletTransactionEvent = z.infer<typeof transactionEvent>;

function trustedUrl(value: unknown, origins: readonly string[]) {
  const { userUrl } = z.object({ userUrl: z.url() }).parse(value);
  const url = new URL(userUrl);
  if (!origins.includes(url.origin) || url.username || url.password)
    throw new Error(
      "The wallet returned a URL outside its configured origins.",
    );
  return url;
}

export function createCip0103Provider(
  request: WalletRequest,
  config: { networkId: string; userOrigins: readonly string[] },
  events?: (signal: AbortSignal) => AsyncIterable<unknown>,
) {
  const ledger: Ledger = async (path, body) => {
    const url = new URL(path, "http://wallet-reader");
    const limit = url.searchParams.get("limit");
    try {
      return await request("ledgerApi", {
        resource: url.pathname,
        requestMethod: body === undefined ? "get" : "post",
        body,
        query: limit === null ? undefined : { limit: Number(limit) },
      });
    } catch (error) {
      if (error instanceof WalletRpcError && error.code === -32001)
        throw new LedgerError(404, url.pathname, error.message);
      throw error;
    }
  };

  return {
    async connect() {
      const response = z
        .object({
          isConnected: z.boolean(),
          userUrl: z.string().optional(),
        })
        .parse(await request("connect"));
      if (response.isConnected && !response.userUrl) return undefined;
      return trustedUrl(response, config.userOrigins);
    },

    async verifyAccount(party: string) {
      z.object({
        connection: z.object({
          isConnected: z.literal(true),
          isNetworkConnected: z.literal(true).optional(),
        }),
      }).parse(await request("status"));
      z.object({ networkId: z.literal(config.networkId) }).parse(
        await request("getActiveNetwork"),
      );
      const accounts = z
        .array(
          z.object({
            partyId: z.string(),
            networkId: z.string().optional(),
          }),
        )
        .parse(await request("listAccounts"));
      if (
        !accounts.some(
          (account) =>
            account.partyId === party &&
            (account.networkId === undefined ||
              account.networkId === config.networkId),
        )
      )
        throw new Error(
          "The wallet does not contain the configured party on this network.",
        );
    },

    ledger,

    async requestApproval(
      commandId: string,
      party: string,
      plan: WalletCommands,
    ) {
      return trustedUrl(
        await request("prepareExecute", {
          commandId,
          actAs: [party],
          commands: plan.commands,
          disclosedContracts: plan.disclosedContracts,
        }),
        config.userOrigins,
      );
    },

    async *transactionEvents(commandId: string, signal: AbortSignal) {
      if (!events) return;
      for await (const value of events(signal)) {
        const event = transactionEvent.safeParse(value);
        if (event.success && event.data.commandId === commandId)
          yield event.data;
      }
    },
  };
}

export type Cip0103Provider = ReturnType<typeof createCip0103Provider>;
