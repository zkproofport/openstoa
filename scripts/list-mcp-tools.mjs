import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const transport = new StreamableHTTPClientTransport(
  new URL('https://stg-community.zkproofport.app/api/mcp')
);
const client = new Client({ name: 'listing', version: '0.0.0' }, { capabilities: {} });
await client.connect(transport);

const { tools } = await client.listTools();
console.log(`Total tools: ${tools.length}`);
for (const t of tools) {
  console.log(`  - ${t.name}`);
}

const { prompts } = await client.listPrompts();
console.log(`\nTotal prompts: ${prompts.length}`);
for (const p of prompts) console.log(`  - ${p.name}`);

await client.close();
