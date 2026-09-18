/**
 * @masselabs/openstoa-commands — the shared command core for the OpenStoa CLI
 * and MCP server. Both front-ends call the same `Commands` methods over the same
 * `@masselabs/openstoa` SDK (typed REST + E2EE MLS chat), so they cannot diverge.
 */
export { Commands, createCommands, resolveApiKey } from './commands';
export type { CommandsDeps, LoginResult } from './commands';
export type {AuthenticateInput,AuthenticateResult} from './loginWorkflow';
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

export { REST_OPERATIONS, getRestOperation, prepareRestOperation } from '@masselabs/openstoa';
export type { RestOperation, OperationParameter } from '@masselabs/openstoa';

export {isProofWorkflowResult,TopicProofWorkflow,FileProofOperationStore,MemoryProofOperationStore} from './topicProofWorkflow';
export type {ProofWorkflowResult,ProofRequirement,ProofContinueInput,ProofAction,ProofOperationStore} from './topicProofWorkflow';

export { OpenStoaApiError } from '@masselabs/openstoa';

export type { TopicProofOptions } from './commands';
