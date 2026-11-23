// Register the tools offered by the Canton MCP server in both protocol eras.
import type { McpServer } from "@modelcontextprotocol/server";
import { registerActionStatusTool } from "./action-status.js";
import { registerGetActivityTool } from "./activity/get-activity.js";
import { registerPaymentContextTool } from "./payments/payment-context.js";
import { registerProposeAcceptGroupRequestTool } from "./splitwell/propose-accept-group-request.js";
import { registerPaymentStatusTool } from "./payments/payment-status.js";
import { registerProposePaymentTool } from "./payments/propose-payment.js";
import { registerRecentActivityTool } from "./activity/recent-activity.js";

export const registerTools = (server: McpServer): void => {
  registerRecentActivityTool(server);
  registerGetActivityTool(server);
  registerPaymentContextTool(server);
  registerProposePaymentTool(server);
  registerPaymentStatusTool(server);
  registerProposeAcceptGroupRequestTool(server);
  registerActionStatusTool(server);
};
