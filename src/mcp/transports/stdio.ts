// Serve the same Canton tools to modern and legacy clients over stdio.
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createServer } from "../server/index.js";

export const startStdioServer = () => serveStdio(createServer);
