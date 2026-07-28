#!/usr/bin/env node
/**
 * MCP stdio smoke test for `@masselabs/openstoa-mcp`.
 *
 * Guards the class of bug that once broke the CLI bin: the entrypoint guard
 * (`isEntrypoint(import.meta.url, process.argv[1])`) silently not firing, so the
 * published binary boots into a no-op and exits 0 without ever speaking MCP.
 * Type-checks and unit tests cannot catch that — only actually running the built
 * binary and getting a JSON-RPC answer back can.
 *
 * What it does:
 *   1. spawns `node packages/mcp/dist/server.js` as a child process,
 *   2. writes a newline-delimited JSON-RPC `initialize` request on stdin
 *      (the MCP stdio transport framing),
 *   3. asserts a well-formed JSON-RPC result comes back on stdout with a
 *      `protocolVersion` and the `openstoa-mcp` server name,
 *   4. sends `notifications/initialized` + a `tools/list` request and asserts a
 *      non-empty tool array,
 *   5. exits non-zero (with the child's stderr) on any hang, crash, or mismatch.
 *
 * The server is driven against a throwaway vault root and a base URL that is
 * never contacted during startup, so the smoke test performs no network I/O and
 * touches nothing under $HOME.
 *
 * Usage:  node scripts/mcp-smoke.mjs [--server <path to server.js>]
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TIMEOUT_MS = Number(process.env.MCP_SMOKE_TIMEOUT_MS ?? 20000);
const PROTOCOL_VERSION = '2024-11-05';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverArgIndex = process.argv.indexOf('--server');
const serverPath =
  serverArgIndex !== -1
    ? path.resolve(process.argv[serverArgIndex + 1])
    : path.join(repoRoot, 'packages', 'mcp', 'dist', 'server.js');

if (!existsSync(serverPath)) {
  console.error(`mcp-smoke: built server not found at ${serverPath}`);
  console.error('mcp-smoke: build it first — (cd packages/mcp && npm run build)');
  process.exit(1);
}

const vaultRoot = mkdtempSync(path.join(tmpdir(), 'openstoa-mcp-smoke-'));

const child = spawn(process.execPath, [serverPath], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: {
    ...process.env,
    // A saved session is optional, but createCommands() needs *some* base URL.
    // Nothing is fetched during startup / initialize / tools-list, so this host
    // is never dialled — it only has to parse as a URL.
    OPENSTOA_BASE_URL: 'http://127.0.0.1:1',
    OPENSTOA_VAULT_ROOT: vaultRoot,
    OPENSTOA_KEYSTORE: 'vault',
    OPENSTOA_DEVICE_ID: 'mcp-smoke',
    // Never let a developer's real credentials leak into the smoke run.
    OPENSTOA_API_KEY: '',
  },
});

let stderr = '';
child.stderr.on('data', (chunk) => {
  stderr += chunk.toString();
});

/** @type {Map<number, (msg: any) => void>} */
const pending = new Map();
let stdoutBuffer = '';
let stdoutRaw = '';

child.stdout.on('data', (chunk) => {
  stdoutRaw += chunk.toString();
  stdoutBuffer += chunk.toString();
  let newline;
  while ((newline = stdoutBuffer.indexOf('\n')) !== -1) {
    const line = stdoutBuffer.slice(0, newline).trim();
    stdoutBuffer = stdoutBuffer.slice(newline + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      fail(`server wrote a non-JSON line on stdout: ${line}`);
      return;
    }
    const resolver = msg.id != null ? pending.get(msg.id) : undefined;
    if (resolver) {
      pending.delete(msg.id);
      resolver(msg);
    }
  }
});

function cleanup() {
  if (!child.killed) child.kill('SIGKILL');
  rmSync(vaultRoot, { recursive: true, force: true });
}

function fail(message) {
  console.error(`mcp-smoke: FAIL — ${message}`);
  if (stderr.trim()) console.error(`mcp-smoke: child stderr:\n${stderr.trim()}`);
  if (stdoutRaw.trim()) console.error(`mcp-smoke: child stdout:\n${stdoutRaw.trim()}`);
  cleanup();
  process.exit(1);
}

child.on('exit', (code, signal) => {
  if (pending.size > 0) {
    fail(`server exited early (code=${code}, signal=${signal}) with requests outstanding`);
  }
});
child.on('error', (err) => fail(`could not spawn server: ${err.message}`));

function send(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function request(id, method, params) {
  return new Promise((resolve) => {
    pending.set(id, resolve);
    send({ jsonrpc: '2.0', id, method, params });
  });
}

const timer = setTimeout(() => {
  fail(`no response within ${TIMEOUT_MS}ms — the server booted but never answered`);
}, TIMEOUT_MS);

try {
  const initialize = await request(1, 'initialize', {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'mcp-smoke', version: '0.0.0' },
  });

  if (initialize.error) fail(`initialize returned an error: ${JSON.stringify(initialize.error)}`);
  if (!initialize.result) fail(`initialize response has no result: ${JSON.stringify(initialize)}`);
  if (!initialize.result.protocolVersion) fail('initialize result is missing protocolVersion');
  if (initialize.result.serverInfo?.name !== 'openstoa-mcp') {
    fail(`unexpected serverInfo.name: ${JSON.stringify(initialize.result.serverInfo)}`);
  }
  console.log(
    `mcp-smoke: initialize OK — server=${initialize.result.serverInfo.name}@${initialize.result.serverInfo.version} protocol=${initialize.result.protocolVersion}`,
  );

  send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  const toolsList = await request(2, 'tools/list', {});
  if (toolsList.error) fail(`tools/list returned an error: ${JSON.stringify(toolsList.error)}`);
  const tools = toolsList.result?.tools;
  if (!Array.isArray(tools) || tools.length === 0) {
    fail(`tools/list returned no tools: ${JSON.stringify(toolsList.result)}`);
  }
  console.log(`mcp-smoke: tools/list OK — ${tools.length} tools registered`);
  console.log(`mcp-smoke: tools = ${tools.map((t) => t.name).join(', ')}`);
} finally {
  clearTimeout(timer);
}

console.log('mcp-smoke: PASS');
cleanup();
process.exit(0);
