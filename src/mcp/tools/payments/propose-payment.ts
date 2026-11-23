// Check the payment policy and queue a Canton Coin transfer for review.
import type { McpServer } from "@modelcontextprotocol/server";
import { registerAction } from "../../shared/actions.js";
import { checkPolicy, readPolicy, transferSchema } from "./payment-rules.js";

export const registerProposePaymentTool = (server: McpServer): void => {
  registerAction(server, {
    id: "payment",
    tool: "propose_payment",
    description: "Queue a Canton Coin transfer for human review.",
    inputSchema: transferSchema,
    async assess(transfer) {
      const policy = await readPolicy();
      const reason = checkPolicy(transfer, policy);
      return reason ? { reason } : { reviewSeconds: policy.reviewSeconds };
    },
  });
};
