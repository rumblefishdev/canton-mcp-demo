// Build the registered server independently of the CLI and transport.
import { McpServer } from "@modelcontextprotocol/server";
import { registerTools } from "../tools/index.js";

export const createServer = (): McpServer => {
  const server = new McpServer({ name: "canton-payments", version: "0.1.0" });
  registerTools(server);
  return server;
};
