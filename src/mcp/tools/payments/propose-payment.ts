// Check the payment policy and queue a Canton Coin transfer for review.
import type { McpServer } from "@modelcontextprotocol/server";
import { registerAction } from "../../shared/actions.js";
import { checkPolicy, readPolicy, transferSchema } from "./payment-rules.js";

export const registerProposePaymentTool = (server: McpServer): void => {
  registerAction(server, {
    id: "payment",
    tool: "propose_payment",
    description:
      "Queue a Canton Coin transfer for human review. If wallet connection is required, open the returned connection_url, connect, and check payment_status using the request ID.",
    inputSchema: transferSchema,
    async assess(transfer) {
      return checkPolicy(transfer, await readPolicy());
    },
  });
};
