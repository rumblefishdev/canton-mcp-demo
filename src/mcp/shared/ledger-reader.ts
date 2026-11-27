import { mkdir } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { dirname } from "node:path";
import { z } from "zod";
import { LedgerError, type Ledger } from "./ledger.js";

const readRoutes = new Map([
  ["/v2/state/ledger-end", "GET"],
  ["/v2/state/latest-pruned-offsets", "GET"],
  ["/v2/updates", "POST"],
  ["/v2/updates/update-by-id", "POST"],
  ["/v2/updates/update-by-hash", "POST"],
]);

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 32_768) throw new Error("Request body too large.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function startLedgerReader(
  socketPath: string,
  party: string,
  getLedger: () => Promise<Ledger>,
  getWalletStatus: () => Promise<object>,
) {
  const eventFormat = z.strictObject({
    filtersByParty: z.strictObject({
      [party]: z.object({ cumulative: z.array(z.unknown()) }),
    }),
    verbose: z.boolean(),
  });
  const updateFormat = z.strictObject({
    includeTransactions: z.strictObject({
      eventFormat,
      transactionShape: z.literal("TRANSACTION_SHAPE_LEDGER_EFFECTS"),
    }),
  });
  const bodies = new Map<string, z.ZodType<object>>([
    [
      "/v2/updates",
      z.strictObject({
        beginExclusive: z.int().nonnegative(),
        endInclusive: z.int().nonnegative(),
        descendingOrder: z.boolean(),
        updateFormat,
      }),
    ],
    [
      "/v2/updates/update-by-id",
      z.strictObject({ updateId: z.string(), updateFormat }),
    ],
    [
      "/v2/updates/update-by-hash",
      z.strictObject({ transactionHash: z.string(), updateFormat }),
    ],
  ]);
  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
  const server = createServer(async (req, res) => {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const url = URL.parse(req.url ?? "/", "http://wallet-reader");
    if (
      url?.pathname === "/wallet/status" &&
      !url.search &&
      req.method === "GET"
    ) {
      reply(200, await getWalletStatus());
      return;
    }
    const allowedMethod = url && readRoutes.get(url.pathname);
    if (!url || !allowedMethod || req.method !== allowedMethod) {
      reply(403, {
        error: "Wallet reader only accepts supported ledger reads.",
      });
      return;
    }
    const limit = url.searchParams.get("limit");
    if (
      url.search &&
      (url.pathname !== "/v2/updates" ||
        !limit ||
        !/^[1-9]\d{0,2}$/.test(limit))
    ) {
      reply(400, { error: "Invalid wallet ledger read query." });
      return;
    }
    let body: object | undefined;
    const schema = bodies.get(url.pathname);
    if (schema) {
      try {
        body = schema.parse(await readBody(req));
      } catch {
        reply(400, {
          error: "Invalid ledger read for the configured wallet party.",
        });
        return;
      }
    }
    try {
      const ledger = await getLedger();
      reply(200, await ledger(url.pathname + url.search, body));
    } catch (error) {
      if (
        error instanceof LedgerError &&
        (error.status === 401 || error.status === 404)
      )
        reply(error.status, { error: error.detail });
      else
        reply(502, {
          error:
            "Wallet ledger read failed. Check the wallet session and provider.",
        });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}
