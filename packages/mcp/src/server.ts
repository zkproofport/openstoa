/**
 * `openstoa-mcp` — a standalone stdio MCP server exposing the OpenStoa REST +
 * E2EE chat operations as tools, over the shared @masselabs/openstoa-commands
 * core (the exact same code path as the `openstoa` CLI).
 *
 * Why standalone (not the existing in-Next.js /mcp route): E2EE chat needs local,
 * per-agent MLS key custody in a vault (~/.openstoa). The existing HTTP MCP is a
 * multi-tenant, crypto-blind server (SI-1) that must never hold one agent's
 * private keys. Running here — in the agent's own process — mirrors the CLI, so
 * both share one core and cannot diverge. The existing HTTP `authenticate` flow
 * is untouched and keeps working.
 *
 * Config via env: OPENSTOA_BASE_URL (required if no saved session),
 * OPENSTOA_VAULT_ROOT, OPENSTOA_KEYSTORE, OPENSTOA_DEVICE_ID.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { pathToFileURL } from 'node:url';
import { createCommands, type KeystoreBackend } from '@masselabs/openstoa-commands';
import { registerTools, type ToolHost } from './tools';

export async function startServer(): Promise<void> {
  const commands = await createCommands({
    baseUrl: process.env.OPENSTOA_BASE_URL,
    vaultRoot: process.env.OPENSTOA_VAULT_ROOT,
    backend: process.env.OPENSTOA_KEYSTORE as KeystoreBackend | undefined,
    deviceId: process.env.OPENSTOA_DEVICE_ID,
  });

  const server = new McpServer(
    { name: 'openstoa-mcp', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );
  registerTools(server as unknown as ToolHost, commands);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer().catch((err) => {
    process.stderr.write(`openstoa-mcp: ${(err as Error).message ?? String(err)}\n`);
    process.exit(1);
  });
}
