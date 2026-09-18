/**
 * createOpenStoaChannel — the production construction path. It reuses the SAME
 * scoped-API-key resolution and file-vault keystore as the CLI/MCP command core
 * (resolveApiKey / resolveHome from @masselabs/openstoa-commands), so keys stay
 * self-custodied in `~/.openstoa/vault/<topicId>/` and nothing is reinvented.
 *
 * A saved proof-login session authenticates the account. A separately selected
 * scoped API key limits its chat/DM permissions. Both are required, and the
 * saved session must belong to the configured server.
 */
import * as path from 'node:path';
import { ChatClient } from '@masselabs/openstoa';
import { FileSessionStore, resolveApiKey, resolveHome, type CommandConfig } from '@masselabs/openstoa-commands';
import { OpenStoaChannel } from './channel';

export interface ChannelConfig extends CommandConfig {
  /** Background poll cadence for `channel.start()`. Default 3000ms. */
  pollIntervalMs?: number;
}

export async function createOpenStoaChannel(config: ChannelConfig = {}): Promise<OpenStoaChannel> {
  if (config.backend && config.backend !== 'vault') {
    throw new Error(
      `keystore backend '${config.backend}' is not supported yet — the channel only wires the file 'vault' backend for E2EE chat today`,
    );
  }
  const home = resolveHome(config.vaultRoot);
  const saved = await new FileSessionStore(path.join(home, 'session.json')).read();
  const baseUrl = config.baseUrl ?? process.env.OPENSTOA_BASE_URL ?? saved?.baseUrl;
  if (!baseUrl) {
    throw new Error('OpenStoa channel: no base URL — pass baseUrl or set OPENSTOA_BASE_URL.');
  }
  const apiKey = await resolveApiKey(config, home);
  if (!apiKey || apiKey.trim().length === 0) {
    throw new Error(
      'OpenStoa channel: a scoped API key (osk_...) is required — set OPENSTOA_API_KEY, pass { apiKey }, or save one to <home>/credentials. Issue one from My page → Settings → AI agents with chat/read + chat/send.',
    );
  }
  if (typeof saved?.token !== 'string' || saved.token.trim().length === 0) {
    throw new Error('OpenStoa channel: a proof-login session is required — run openstoa login with the same vault before starting the channel.');
  }
  if (typeof saved.baseUrl !== 'string' || saved.baseUrl.replace(/\/+$/, '') !== baseUrl.replace(/\/+$/, '')) {
    throw new Error('OpenStoa channel: the saved session does not match the configured base URL — log in to that server before starting the channel.');
  }
  const chat = new ChatClient({ baseUrl, vaultRoot: config.vaultRoot, deviceId: config.deviceId, apiKey, token: saved.token });
  return new OpenStoaChannel({ chat, pollIntervalMs: config.pollIntervalMs });
}
