/** Local stdio MCP server. CLI and MCP share command workflows and local MLS
 * key custody. Proof login establishes identity; a separate owner-issued key
 * authorizes business requests. There is no hosted /mcp endpoint.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createCommands, isEntrypoint, type KeystoreBackend } from '@masselabs/openstoa-commands';
import { registerTools, type ToolHost } from './tools';
import { version } from '../package.json';

export async function startServer(): Promise<void> {
  const commands = await createCommands({
    baseUrl: process.env.OPENSTOA_BASE_URL,
    vaultRoot: process.env.OPENSTOA_VAULT_ROOT,
    backend: process.env.OPENSTOA_KEYSTORE as KeystoreBackend | undefined,
    deviceId: process.env.OPENSTOA_DEVICE_ID,
    apiKey: process.env.OPENSTOA_API_KEY,
  });

  const server = new McpServer(
    { name: 'openstoa-mcp', version },
    { capabilities: { tools: {} } },
  );
  registerTools(server as unknown as ToolHost, commands);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Only auto-run when invoked as the executable (not when imported by tests).
// isEntrypoint resolves argv[1] through the npm bin symlink — see its docs.
if (isEntrypoint(import.meta.url, process.argv[1])) {
  startServer().catch((err) => {
    process.stderr.write(`openstoa-mcp: ${(err as Error).message ?? String(err)}\n`);
    process.exit(1);
  });
}
