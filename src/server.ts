import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { listActivePings, pingStatus, preparePing, releaseDirectory } from './canton.js';
import { requestIdSchema } from './state.js';

function toolResult(data: Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data) }],
    structuredContent: data,
  };
}

if (process.argv.includes('--client-config')) {
  console.log(JSON.stringify({
    mcpServers: {
      'canton-demo': {
        command: process.execPath,
        args: [fileURLToPath(import.meta.url)],
        env: { CANTON_RELEASE: releaseDirectory() },
      },
    },
  }, null, 2));
} else {
  const server = new McpServer({ name: 'canton-local-signing-demo', version: '0.1.0' });

  server.registerTool('prepare_ping', {
    description: 'Prepare a Ping from demo party Alice to Bob for separate human review.',
  }, async () => toolResult(await preparePing()));

  server.registerTool('ping_status', {
    description: 'Report the state of a demo request and its ledger update ID if confirmed.',
    inputSchema: { request_id: requestIdSchema },
  }, async ({ request_id }) => toolResult(await pingStatus(request_id)));

  server.registerTool('list_active_pings', {
    description: 'List active Ping contracts visible to the configured demo party Alice.',
  }, async () => toolResult(await listActivePings()));

  await server.connect(new StdioServerTransport());
}
