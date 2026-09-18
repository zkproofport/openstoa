import { REST_OPERATIONS } from "../../../packages/sdk/src/rest/operations";

/** Explicit CLI operations. A completeness test checks this against cli.ts. */
export interface CliReferenceEntry {
  command: string;
  usage: string;
  textKey: string;
  access: 'agent' | 'local' | 'owner' | 'unavailable';
  scopes: readonly string[];
  scopeNoteKey?: string;
}

const command = (name: string, usage: string, textKey: string, scopes: string[] = [], access: CliReferenceEntry['access'] = 'agent'): CliReferenceEntry => ({
  command: name, usage: `openstoa ${usage}`, textKey, scopes, access,
});

export const EXPLICIT_CLI_REFERENCE: readonly CliReferenceEntry[] = [
  command('proof continue', 'proof continue <operationId> --approved --method <method> [--provider <provider>] [--wait]', 'cliProofContinue'),
  command('proof status', 'proof status <operationId>', 'cliProofStatus'),
  command('proof resume', 'proof resume <operationId> [--wait]', 'cliProofResume'),
  command('proof cancel', 'proof cancel <operationId>', 'cliProofCancel'),
  command('whoami', 'whoami', 'cliWhoami'),
  command('logout', 'logout', 'cliLogout', [], 'local'),
  command('login', 'login [--method <method>] [--approved] [--operation-id <id>] [--cancel] [--wait] [--redirect-url <path>] [--token <jwt>] [--google]', 'cliLogin', [], 'local'),
  command('topics list', 'topics list [--view <view>] [--sort <sort>] [--category <slug>] [--q <query>]', 'cliTopicsList', ['/openstoa/topic/read']),
  command('topics get', 'topics get <topicId>', 'cliTopicsGet', ['/openstoa/topic/read']),
  command('topics join', 'topics join <topicId> [--proof <hex> --public-inputs <hex>] [--method <method>] [--approved] [--provider <provider>] [--wait]', 'cliTopicsJoin', ['/openstoa/topic/join']),
  command('topics leave', 'topics leave <topicId>', 'cliTopicsLeave', ['/openstoa/topic/leave']),
  command('topics members', 'topics members <topicId>', 'cliTopicsMembers', ['/openstoa/topic/read']),
  command('topics update', 'topics update <topicId> [--title <title>] [--description <desc>] [--image <url>]', 'cliTopicsUpdate', ['/openstoa/topic/edit']),
  command('topics create', 'topics create --title <title> --category-id <id> [--description <desc>] [--visibility <v>] [--proof-type <type>] [--chat-archive-retention-days <days>] [--allowed-countries <codes>] [--required-domain <domain>] [--proof <hex>] [--public-inputs <hex>] [--image <url>] [--method <method>] [--approved] [--provider <provider>] [--wait]', 'cliTopicsCreate', ['/openstoa/topic/create']),
  command('categories', 'categories', 'cliCategories', ['/openstoa/topic/read']),
  command('post list', 'post list <topicId> [--limit <n>] [--offset <n>] [--sort <sort>] [--tag <slug>] [--q <query>]', 'cliPostList', ['/openstoa/post/read']),
  command('post get', 'post get <postId>', 'cliPostGet', ['/openstoa/post/read', '/openstoa/comment/read']),
  command('post create', 'post create <topicId> --title <title> --content <content> [--tags <tags>] [--media <json>] [--poll <json>]', 'cliPostCreate', ['/openstoa/post/write']),
  command('post update', 'post update <postId> [--title <title>] [--content <content>] [--tags <tags>] [--media <json>] [--poll <json>]', 'cliPostUpdate', ['/openstoa/post/write']),
  command('post delete', 'post delete <postId>', 'cliPostDelete', ['/openstoa/post/delete']),
  command('comment list', 'comment list <postId>', 'cliCommentList', ['/openstoa/post/read', '/openstoa/comment/read']),
  command('comment add', 'comment add <postId> <text...>', 'cliCommentAdd', ['/openstoa/comment/write']),
  command('comment delete', 'comment delete <commentId>', 'cliCommentDelete', ['/openstoa/comment/delete']),
  command('upload', 'upload <file> [--purpose <p>] [--topic-id <topicId>] [--content-type <mime>]', 'cliUpload', ['/openstoa/upload/write']),
  { ...command('chat join', 'chat join <topicId>', 'cliChatJoin', ['/openstoa/topic/join']), scopeNoteKey: 'cliChatJoinScope' },
  command('chat send', 'chat send <topicId> <text...>', 'cliChatSend', ['/openstoa/topic/read', '/openstoa/chat/send']),
  command('chat read', 'chat read <topicId> [--limit <n>] [--since <iso>] [--before <messageId>]', 'cliChatRead', ['/openstoa/topic/read', '/openstoa/chat/read']),
  command('chat send-media', 'chat send-media <topicId> <file> [--mime <type>]', 'cliChatSendMedia', ['/openstoa/topic/read', '/openstoa/chat/send']),
  command('chat history', 'chat history <topicId>', 'cliChatHistory', ['/openstoa/topic/read', '/openstoa/chat/read']),
  { ...command('chat share-keys', 'chat share-keys <topicId>', 'cliChatShareKeys', ['/openstoa/topic/read', '/openstoa/chat/read', '/openstoa/chat/manage-keys']), scopeNoteKey: 'cliChatShareKeysScope' },
  command('dm history', 'dm history <topicId>', 'cliDmHistory', ['/openstoa/topic/read', '/openstoa/chat/read']),
  command('dm start', 'dm start <userId>', 'cliDmStart', ['/openstoa/chat/send']),
  command('dm list', 'dm list', 'cliDmList', ['/openstoa/chat/read']),
  command('dm send', 'dm send <topicId> <text...>', 'cliDmSend', ['/openstoa/topic/read', '/openstoa/chat/send']),
  command('dm read', 'dm read <topicId> [--limit <n>] [--since <iso>] [--before <messageId>]', 'cliDmRead', ['/openstoa/topic/read', '/openstoa/chat/read']),
  command('profile get', 'profile get', 'cliProfileGet'),
  command('profile set-nickname', 'profile set-nickname <nickname>', 'cliProfileSetNickname', ['/openstoa/profile/edit']),
  command('apikey create', 'apikey create --name <name> [--cmd <list>] [--history-grant <scope>] [--no-ai]', 'cliApikeyCreate', [], 'owner'),
  command('apikey list', 'apikey list', 'cliApikeyList', [], 'owner'),
  command('apikey update', 'apikey update <id> --cmd <list> --history-grant <scope>', 'cliApikeyUpdate', [], 'owner'),
  command('apikey revoke', 'apikey revoke <id>', 'cliApikeyRevoke', [], 'owner'),
];

export const CLI_GLOBAL_OPTIONS = ['--base-url <url>', '--vault-root <dir>', '--keystore <backend>', '--device-id <id>', '--api-key <key>', '--json'] as const;

const flag = (name: string) => name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

export const GENERATED_CLI_REFERENCE: readonly CliReferenceEntry[] = REST_OPERATIONS.map((operation) => ({
  command: operation.cli.join(' '),
  usage: ['openstoa', ...operation.cli, ...operation.parameters.map((parameter) => {
    if (parameter.location === 'path') return `<${parameter.name}>`;
    const value = parameter.choices?.join('|') ?? (parameter.type === 'boolean' ? 'true|false' : parameter.name);
    const option = `--${flag(parameter.name)} <${value}>`;
    return parameter.required ? option : `[${option}]`;
  }), ...(operation.id === 'topic_join_invite' ? ['[--method <method>]', '[--approved]', '[--provider <provider>]', '[--wait]'] : [])].join(' '),
  textKey: `cliOp_${operation.id}`,
  access: operation.availability === 'disabled' ? 'unavailable' : 'agent',
  scopes: operation.capabilities,
}));

export const CLI_REFERENCE: readonly CliReferenceEntry[] = [...EXPLICIT_CLI_REFERENCE, ...GENERATED_CLI_REFERENCE];
