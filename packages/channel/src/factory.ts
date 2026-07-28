/**
 * createOpenStoaChannel — the production construction path. It reuses the SAME
 * scoped-API-key resolution and file-vault keystore as the CLI/MCP command core
 * (resolveApiKey / resolveHome from @masselabs/openstoa-commands), so keys stay
 * self-custodied in `~/.openstoa/vault/<topicId>/` and nothing is reinvented.
 *
 * Auth is a scoped API key (`osk_...`) with the `chat/read` + `chat/send` (and
 * DM) capabilities — issued from Profile → AI permissions. A missing/blank key
 * fails fast with a clear error rather than silently starting unauthenticated.
 */
import { ChatClient } from '@masselabs/openstoa';
import { resolveApiKey, resolveHome, type CommandConfig } from '@masselabs/openstoa-commands';
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
  const baseUrl = config.baseUrl ?? process.env.OPENSTOA_BASE_URL;
  if (!baseUrl) {
    throw new Error('OpenStoa channel: no base URL — pass baseUrl or set OPENSTOA_BASE_URL.');
  }
  const home = resolveHome(config.vaultRoot);
  const apiKey = await resolveApiKey(config, home);
  if (!apiKey || apiKey.trim().length === 0) {
    throw new Error(
      'OpenStoa channel: a scoped API key (osk_...) is required — set OPENSTOA_API_KEY, pass { apiKey }, or save one to <home>/credentials. Issue one from Profile → AI permissions with chat/read + chat/send.',
    );
  }
  const chat = new ChatClient({ baseUrl, vaultRoot: config.vaultRoot, deviceId: config.deviceId, apiKey });
  return new OpenStoaChannel({ chat, pollIntervalMs: config.pollIntervalMs });
}
