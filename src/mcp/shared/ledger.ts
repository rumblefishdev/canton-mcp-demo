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

export function connectLedger(url: string, token: string) {
  return async (path: string, body?: object): Promise<unknown> => {
    const response = await fetch(new URL(path, url), {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(25_000),
    });
    if (!response.ok)
      throw new LedgerError(
        response.status,
        path,
        (await response.text()).slice(0, 500),
      );
    return response.json();
  };
}

export type Ledger = ReturnType<typeof connectLedger>;
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

function eventFormat(party: string, includeCreatedEventBlob = false) {
  return {
    filtersByParty: {
      [party]: {
        cumulative: [
          {
            identifierFilter: {
              WildcardFilter: { value: { includeCreatedEventBlob } },
            },
          },
        ],
      },
    },
    verbose: true,
  };
}

function transactionFormat(party: string) {
  return {
    eventFormat: { ...eventFormat(party), verbose: false },
    transactionShape: "TRANSACTION_SHAPE_LEDGER_EFFECTS",
  };
}

export async function readContract(
  ledger: Ledger,
  party: string,
  contractId: string,
  includeCreatedEventBlob = false,
) {
  try {
    const response = z
      .object({
        created: z
          .object({
            synchronizerId: z.string(),
            createdEvent: z.object({
              templateId: z.string(),
              contractId: z.string(),
              createArgument: z.unknown(),
              createdEventBlob: z.string().optional(),
            }),
          })
          .nullish(),
        archived: z.unknown(),
      })
      .parse(
        await ledger("/v2/events/events-by-contract-id", {
          contractId,
          eventFormat: eventFormat(party, includeCreatedEventBlob),
        }),
      );
    if (
      !response.created ||
      response.archived != null ||
      response.created.createdEvent.contractId !== contractId
    )
      return;
    return {
      ...response.created.createdEvent,
      synchronizerId: response.created.synchronizerId,
    };
  } catch (error) {
    if (error instanceof LedgerError && error.status === 404) return;
    throw error;
  }
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
