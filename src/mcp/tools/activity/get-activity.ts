// Look up a confirmed update through the configured party's ledger permissions.
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { connectReader, result } from "../../shared/actions.js";
import { getTransaction, LedgerError } from "../../shared/ledger.js";
import { summarize } from "./summarize.js";

const CONFIG = {
  description:
    "Read a specific confirmed ledger update through the configured party’s permissions.",
  inputSchema: z.object({
    update_id: z.string().min(1).max(255).describe("Canton ledger update ID."),
  }),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export const registerGetActivityTool = (server: McpServer): void => {
  server.registerTool("get_activity", CONFIG, async ({ update_id }) => {
    const { config, ledger } = await connectReader();
    try {
      const update = await getTransaction(ledger, config.sender, update_id);
      return result(update ? summarize(update) : { status: "not_visible" });
    } catch (error) {
      if (error instanceof LedgerError && error.status === 404)
        return result({ status: "not_visible" });
      throw error;
    }
  });
};
