#!/usr/bin/env node

// Launch the stdio server or print its configuration for an MCP client.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  profileDirectory,
  policyFile,
  readerTokenFile,
} from "./shared/profile.js";
import { startStdioServer } from "./transports/stdio.js";

if (process.argv.includes("--client-config")) {
  const ledgerUrl = process.env.CANTON_PAYMENT_LEDGER_URL;
  console.log(
    JSON.stringify(
      {
        mcpServers: {
          "canton-payments": {
            command: process.execPath,
            args: [fileURLToPath(import.meta.url)],
            env: {
              CANTON_PAYMENT_DIRECTORY: resolve(profileDirectory),
              CANTON_PAYMENT_POLICY: resolve(policyFile),
              CANTON_PAYMENT_READER_TOKEN_FILE: resolve(readerTokenFile),
              ...(ledgerUrl ? { CANTON_PAYMENT_LEDGER_URL: ledgerUrl } : {}),
            },
          },
        },
      },
      null,
      2,
    ),
  );
} else {
  startStdioServer();
}
