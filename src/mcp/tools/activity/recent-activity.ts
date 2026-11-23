// Read the latest ledger updates visible to the configured party.
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { connectReader, result } from "../../shared/actions.js";
import {
  ledgerEnd,
  pruningOffset,
  readTransactions,
} from "../../shared/ledger.js";
import { summarize } from "./summarize.js";

const CONFIG = {
  description:
    "Read bounded recent Canton transactions visible to the configured party.",
  inputSchema: z.object({
    limit: z
      .number()
      .int()
      .min(1)
      .max(25)
      .default(10)
      .describe("Maximum number of updates to return."),
  }),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export const registerRecentActivityTool = (server: McpServer): void => {
  server.registerTool("recent_activity", CONFIG, async ({ limit }) => {
    const { config, ledger } = await connectReader();
    const [end, pruned] = await Promise.all([
      ledgerEnd(ledger),
      pruningOffset(ledger),
    ]);
    const updates = await readTransactions(
      ledger,
      config.sender,
      pruned,
      end,
      limit,
      true,
    );
    return result({
      party: config.sender,
      updates: updates.slice(0, limit).map(summarize),
    });
  });
};
