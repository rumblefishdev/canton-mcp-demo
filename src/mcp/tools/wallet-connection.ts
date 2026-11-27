import type { McpServer } from "@modelcontextprotocol/server";
import { result } from "../shared/actions.js";
import { walletStatus } from "../shared/wallet-status.js";

export function registerWalletConnectionTool(server: McpServer) {
  server.registerTool(
    "wallet_connection",
    {
      description:
        "Check whether the configured wallet is connected. If login is needed, open the returned connection_url and check again after connecting.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async () => result(await walletStatus()),
  );
}
