import { request } from "node:http";
import { json } from "node:stream/consumers";
import { z } from "zod";
const offsetSchema = z
  .union([z.string().regex(/^\d+$/), z.number().int().nonnegative()])
  .transform(Number)
  .pipe(z.number().int().nonnegative());

export class LedgerError extends Error {
  constructor(
    readonly status: number,
    path: string,
    readonly detail: string,
  ) {
    super(`Canton ${path} returned HTTP ${status}: ${detail}`);
  }
}

export type Ledger = (path: string, body?: object) => Promise<unknown>;

export function connectCompanionReader(socketPath: string): Ledger {
  return (path, body) =>
    new Promise((resolve, reject) => {
      const requestBody = body === undefined ? undefined : JSON.stringify(body);
      const req = request(
        {
          socketPath,
          path,
          method: body === undefined ? "GET" : "POST",
          signal: AbortSignal.timeout(40_000),
          headers:
            requestBody === undefined
              ? {}
              : {
                  "Content-Type": "application/json",
                  "Content-Length": Buffer.byteLength(requestBody),
                },
        },
        (response) => {
          void json(response)
            .then((result) => {
              const status = response.statusCode ?? 502;
              if (status >= 200 && status < 300) resolve(result);
              else
                reject(
                  new LedgerError(
                    status,
                    path,
                    z.object({ error: z.string() }).parse(result).error,
                  ),
                );
            })
            .catch(reject);
        },
      );
      req.once("error", () =>
        reject(
          new Error(
            "The wallet reader is unavailable. Check that the wallet companion is running.",
          ),
        ),
      );
      req.end(requestBody);
    });
}
const eventDetails = z.object({
  templateId: z.string(),
  contractId: z.string(),
  choice: z.string().optional(),
  exerciseResult: z
    .object({ output: z.object({ tag: z.string() }) })
    .optional()
    .catch(undefined),
});
const eventSchema = z.union([
  z.object({ CreatedEvent: eventDetails }),
  z.object({ ArchivedEvent: eventDetails }),
  z.object({ ExercisedEvent: eventDetails }),
]);

const transactionSchema = z.object({
  updateId: z.string(),
  commandId: z.string().optional(),
  offset: offsetSchema,
  effectiveAt: z.string(),
  events: z.array(eventSchema),
});
export type Transaction = z.infer<typeof transactionSchema>;
const updateSchema = z.object({
  update: z.object({
    Transaction: z.object({ value: transactionSchema }).optional(),
  }),
});

function transactionFormat(party: string) {
  return {
    eventFormat: {
      filtersByParty: {
        [party]: {
          cumulative: [
            {
              identifierFilter: {
                WildcardFilter: { value: { includeCreatedEventBlob: false } },
              },
            },
          ],
        },
      },
      verbose: false,
    },
    transactionShape: "TRANSACTION_SHAPE_LEDGER_EFFECTS",
  };
}

export async function ledgerEnd(ledger: Ledger) {
  return z
    .object({ offset: offsetSchema })
    .parse(await ledger("/v2/state/ledger-end")).offset;
}

export async function readTransactions(
  ledger: Ledger,
  party: string,
  beginExclusive: number,
  endInclusive: number,
  limit: number,
  descendingOrder: boolean,
) {
  if (endInclusive <= beginExclusive) return [];
  const updates = z.array(updateSchema).parse(
    await ledger(`/v2/updates?limit=${limit}`, {
      beginExclusive,
      endInclusive,
      descendingOrder,
      updateFormat: { includeTransactions: transactionFormat(party) },
    }),
  );
  return updates.flatMap(({ update }) =>
    update.Transaction ? [update.Transaction.value] : [],
  );
}

export async function getTransaction(
  ledger: Ledger,
  party: string,
  updateId: string,
) {
  const response = updateSchema.parse(
    await ledger("/v2/updates/update-by-id", {
      updateId,
      updateFormat: { includeTransactions: transactionFormat(party) },
    }),
  );
  return response.update.Transaction?.value;
}

export async function findTransactionByHash(
  ledger: Ledger,
  party: string,
  transactionHash: string,
) {
  try {
    const response = updateSchema.parse(
      await ledger("/v2/updates/update-by-hash", {
        transactionHash,
        updateFormat: { includeTransactions: transactionFormat(party) },
      }),
    );
    return response.update.Transaction?.value;
  } catch (error) {
    if (error instanceof LedgerError && error.status === 404) return undefined;
    throw error;
  }
}

export async function pruningOffset(ledger: Ledger) {
  const response = z
    .object({ participantPrunedUpToInclusive: offsetSchema.default(0) })
    .parse(await ledger("/v2/state/latest-pruned-offsets"));
  return response.participantPrunedUpToInclusive;
}
