/**
 * @masselabs/openstoa-commands — the shared command core for the OpenStoa CLI
 * and MCP server. Both front-ends call the same `Commands` methods over the same
 * `@masselabs/openstoa` SDK (typed REST + E2EE MLS chat), so they cannot diverge.
 */
export { Commands, createCommands, resolveApiKey } from './commands';
export type { CommandsDeps, LoginResult } from './commands';
// TEMPORARILY DISABLED — the ZKProofport AI prover (ai.zkproofport.app) is offline
// (shut down for cost). The device flow needs it for the x402 proof step.
// To restore: bring the prover back up, then uncomment these exports + ./deviceLogin.ts
// + the CLI --google option + the MCP openstoa_authenticate tool. Nothing else changed.
// export type { GoogleLoginResult, GoogleAuthResult } from './commands';
// export {
//   defaultSpawnProve,
//   resolveProvePath,
//   startDeviceLogin,
//   awaitProof,
//   parseDeviceInfo,
//   DEVICE_INFO_TIMEOUT_MS,
//   MAX_SPAWN_ATTEMPTS,
// } from './deviceLogin';
// export type { DeviceCodeInfo, ProveSpawner, ChildProcessLike, PendingDeviceLogin } from './deviceLogin';
export { FileSessionStore, MemorySessionStore } from './session';
export type { SessionData, SessionStore } from './session';
export { readCredentials } from './credentials';
export type { Credentials } from './credentials';
export { expandHome, resolveHome } from './config';
export type { CommandConfig, KeystoreBackend } from './config';
export { isEntrypoint } from './entrypoint';

// Re-export the SDK domain types callers format against, so an adapter only ever
// needs to depend on @masselabs/openstoa-commands.
export type {
  ChatMessage,
  Topic,
  TopicMember,
  DmChannel,
  Post,
  Comment,
  Category,
  CreateTopicInput,
  CreatePostInput,
  SessionPayload,
  ApiKeyMeta,
  ApiKeyCreateInput,
  ApiKeyCreateResult,
} from '@masselabs/openstoa';
