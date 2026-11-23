// Expose the shared proposal status and keep the payment-only status entry point.
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { actionStatus, result } from "../shared/actions.js";
import { requestIdSchema } from "../shared/files.js";

const INPUT_SCHEMA = z.object({
  request_id: requestIdSchema.describe(
    "Request ID returned by a proposal tool.",
  ),
});

export const registerActionStatusTool = (
  server: McpServer,
  name = "action_status",
  action?: string,
): void => {
  server.registerTool(
    name,
    {
      description: action
        ? `Get the decision and ledger outcome for a ${action} proposal.`
        : "Get the decision and ledger outcome for an action proposal.",
      inputSchema: INPUT_SCHEMA,
      // A successful recovery can persist one local confirmation record.
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ request_id }) => result(await actionStatus(request_id, action)),
  );
};
