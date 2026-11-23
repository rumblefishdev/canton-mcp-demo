// Expose the configured sender and payment limits before an agent proposes a transfer.
import type { McpServer } from "@modelcontextprotocol/server";
import { result } from "../../shared/actions.js";
import { asset, readPolicy } from "./payment-rules.js";
import { readProfile } from "../../shared/profile.js";

const CONFIG = {
  description:
    "Show the configured sender, allowed recipients, and payment proposal policy.",
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export const registerPaymentContextTool = (server: McpServer): void => {
  server.registerTool("payment_context", CONFIG, async () => {
    const [config, policy] = await Promise.all([readProfile(), readPolicy()]);
    return result({ sender: config.sender, asset, ...policy });
  });
};
