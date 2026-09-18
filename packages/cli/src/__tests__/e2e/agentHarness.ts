/** Local-only CLI/MCP integration fixtures. API keys never enter argv or logs.
 * A human dev session issues each permission key; a separate matching agent login is mandatory; tests clean only their own accounts. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
export const BASE = process.env.E2E_BASE_URL;
export const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../dist/cli.js');
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
export interface Owner { userId: string; nickname: string; token: string }
export interface Agent { owner: Owner; keyId: string; apiKey: string; sessionToken: string; root: string; deviceId: string }
export interface Row { [key: string]: any }

export class LocalAgents {
  readonly cliInvocations: string[][] = [];
  private uploads: Array<{ token: string; url: string }> = [];
  private owners: Owner[] = [];
  private roots: string[] = [];
  private secrets: string[] = [];
  private keySessions = new Map<string, string>();
  private agentSessions = new Map<string, string>();
  async ready() {
    if (!BASE) throw new Error('Set E2E_BASE_URL=http://localhost:3200 explicitly.');
    const origin = new URL(BASE);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname) || origin.port !== '3200') {
      throw new Error('These disposable fixtures may run only on the local OpenStoa stack at port 3200.');
    }
    const health = await fetch(`${BASE}/api/health`);
    if (!health.ok) throw new Error('Local stack is not healthy. Run the repository scripts/dev.sh first.');
    await fs.access(CLI);
  }
  redact(value: string): string {
    for (const secret of this.secrets) value = value.split(secret).join('[redacted]');
    return value;
  }
  async request<T = Row>(token: string | null, route: string, method = 'GET', body?: unknown): Promise<{ status: number; body: T }> {
    const pairedSession = token ? this.keySessions.get(token) : undefined;
    const response = await fetch(`${BASE}${route}`, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${pairedSession ?? token}` } : {}), ...(pairedSession ? { 'X-OpenStoa-API-Key': token! } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json();
    return { status: response.status, body: data as T };
  }
  async owner(label: string): Promise<Owner> {
    const nickname = `e2e_${label}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`;
    const result = await this.request<Owner>(null, '/api/auth/dev-login', 'POST', { nickname });
    if (result.status !== 200 || !result.body.token) throw new Error(`Cannot provision disposable owner: HTTP ${result.status}`);
    this.owners.push(result.body);
    this.secrets.push(result.body.token);
    return result.body;
  }
  async agent(owner: Owner, opts: { cmd?: string[]; historyGrant?: string } = {}): Promise<Agent> {
    let cmd = opts.cmd;
    if (!cmd) {
      const result = await this.request(owner.token, '/api/profile/api-keys');
      cmd = result.body.allowedCmd;
      if (result.status !== 200 || !Array.isArray(cmd)) throw new Error('Owner cannot read the capability catalogue.');
    }
    const result = await this.request(owner.token, '/api/profile/api-keys', 'POST', { name: 'local-agent-workflow', cmd, historyGrant: opts.historyGrant ?? 'full', isAI: true });
    if (result.status !== 201 || !result.body.rawKey) throw new Error(`Cannot provision scoped API key: HTTP ${result.status}`);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'openstoa-agent-e2e-'));
    this.roots.push(root);
    let sessionToken = this.agentSessions.get(owner.userId);
    if (!sessionToken) {
      const login = await this.request<Owner>(null, '/api/auth/dev-login', 'POST', { nickname: owner.nickname, isAI: true });
      if (login.status !== 200 || login.body.userId !== owner.userId || !login.body.token) throw new Error('Cannot provision a matching agent login session.');
      sessionToken = login.body.token; this.agentSessions.set(owner.userId, sessionToken);
    }
    await fs.writeFile(path.join(root, 'session.json'), JSON.stringify({ baseUrl: BASE, token: sessionToken, userId: owner.userId, nickname: owner.nickname }), { mode: 0o600 });
    this.keySessions.set(result.body.rawKey, sessionToken);
    this.secrets.push(result.body.rawKey, sessionToken);
    return { owner, root, sessionToken, apiKey: result.body.rawKey, keyId: result.body.key.id, deviceId: `test_${path.basename(root)}` };
  }
  authHeaders(agent: Agent): Record<string, string> {
    return { Authorization: `Bearer ${agent.sessionToken}`, 'X-OpenStoa-API-Key': agent.apiKey };
  }
  env(agent: Agent): Record<string, string> {
    return { PATH: process.env.PATH ?? '', OPENSTOA_BASE_URL: BASE!, OPENSTOA_API_KEY: agent.apiKey, OPENSTOA_VAULT_ROOT: agent.root, OPENSTOA_KEYSTORE: 'vault', OPENSTOA_DEVICE_ID: agent.deviceId };
  }
  async cli<T = Row>(agent: Agent, args: string[]): Promise<T> {
    const result = await this.cliResult(agent, args);
    if (result.code !== 0) throw new Error(`CLI ${args.slice(0, 2).join(' ')} failed: ${result.stderr}`);
    return JSON.parse(result.stdout) as T;
  }
  async cliResult(agent: Agent, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    this.cliInvocations.push(args.slice(0, 2));
    try {
      const result = await exec(process.execPath, [CLI, '--json', '--base-url', BASE!, '--vault-root', agent.root, '--device-id', agent.deviceId, ...args], { env: this.env(agent), maxBuffer: 16 * 1024 * 1024, timeout: 110_000 });
      return { code: 0, stdout: this.redact(result.stdout), stderr: this.redact(result.stderr) };
    } catch (e) {
      const err = e as { code?: number; stdout?: string; stderr?: string };
      return { code: typeof err.code === 'number' ? err.code : 1, stdout: this.redact(err.stdout ?? ''), stderr: this.redact(err.stderr ?? 'CLI execution failed') };
    }
  }
  trackUpload(agent: Agent, url: string) {
    this.uploads.push({ token: agent.apiKey, url });
  }
  async dispose() {
    const failures: string[] = [];
    for (const upload of this.uploads) {
      try {
        const result = await this.request(upload.token, '/api/upload', 'DELETE', { urls: [upload.url] });
        if (result.status !== 200) failures.push(`upload cleanup: HTTP ${result.status}`);
      } catch { failures.push('upload cleanup request failed'); }
    }
    for (const owner of this.owners.reverse()) {
      try {
        let result = await this.request(owner.token, '/api/account', 'DELETE');
        if (result.status === 409 && Array.isArray(result.body.topics)) {
          // A freshly created fixture account owns no user data. The account
          // route returns only its own non-personal topics, including DMs.
          for (const topic of result.body.topics) {
            const deleted = await this.request(owner.token, `/api/topics/${topic.id}`, 'DELETE');
            if (deleted.status !== 200) failures.push(`topic cleanup: HTTP ${deleted.status}`);
          }
          result = await this.request(owner.token, '/api/account', 'DELETE');
        }
        if (result.status !== 200) failures.push(`owner cleanup: HTTP ${result.status}`);
      } catch { failures.push('owner cleanup request failed'); }
    }
    for (const root of this.roots) await fs.rm(root, { recursive: true, force: true });
    if (failures.length) throw new Error(failures.join('; '));
  }
}
