// Keep the payment-specific status lookup scoped to payment proposals.
import type { McpServer } from "@modelcontextprotocol/server";
import { registerActionStatusTool } from "../action-status.js";

export const registerPaymentStatusTool = (server: McpServer): void => {
  registerActionStatusTool(server, "payment_status", "payment");
};
