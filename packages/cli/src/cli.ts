/**
 * `openstoa` CLI. A thin commander front-end over the shared command core
 * (@masselabs/openstoa-commands). NO business logic lives here — every action
 * resolves a Commands instance and calls one of its methods, so the CLI and the
 * MCP server stay in lockstep. `--json` emits the raw structured result.
 */
import { Command } from 'commander';
import { pathToFileURL } from 'node:url';
import { createCommands, type Commands, type CommandConfig } from '@masselabs/openstoa-commands';
import * as fmt from './format';

export type CommandsFactory = (config: CommandConfig) => Promise<Commands>;
const defaultFactory: CommandsFactory = (config) => createCommands(config);

interface GlobalOpts {
  baseUrl?: string;
  vaultRoot?: string;
  keystore?: 'vault' | 'keychain';
  deviceId?: string;
  apiKey?: string;
  json?: boolean;
}

export function buildProgram(
  factory: CommandsFactory = defaultFactory,
  write: (s: string) => void = (s) => process.stdout.write(s + '\n'),
): Command {
  const program = new Command();
  program
    .name('openstoa')
    .description('OpenStoa CLI — REST + E2EE chat over @masselabs/openstoa (same core as the MCP server)')
    .option('--base-url <url>', 'OpenStoa origin (else OPENSTOA_BASE_URL, else the saved session)')
    .option('--vault-root <dir>', 'the .openstoa home dir for keys + session (default ~/.openstoa)')
    .option('--keystore <backend>', 'keystore backend: vault (default) | keychain')
    .option('--device-id <id>', 'stable MLS device identity override')
    .option('--api-key <key>', 'scoped API key — skips interactive login (else OPENSTOA_API_KEY, else ~/.openstoa/credentials)')
    .option('--json', 'machine-readable JSON output')
    .enablePositionalOptions();

  const globals = (): GlobalOpts => program.opts<GlobalOpts>();
  const config = (): CommandConfig => {
    const g = globals();
    return { baseUrl: g.baseUrl, vaultRoot: g.vaultRoot, backend: g.keystore, deviceId: g.deviceId, apiKey: g.apiKey };
  };

  async function run<T>(fn: (c: Commands) => Promise<T>, human: (r: T) => string): Promise<void> {
    const cmds = await factory(config());
    const result = await fn(cmds);
    write(globals().json ? JSON.stringify(result, null, 2) : human(result));
  }

  // ── auth ──────────────────────────────────────────────────────────────
  program
    .command('login')
    .description('dev-login (default) or adopt an existing Bearer with --token')
    .option('--nickname <name>', 'nickname for a fresh dev-login user')
    .option('--token <jwt>', 'adopt an externally-obtained Bearer (e.g. an AI verify token)')
    .action((opts: { nickname?: string; token?: string }) =>
      run((c) => c.login({ nickname: opts.nickname, token: opts.token }), fmt.fmtLogin),
    );

  program
    .command('logout')
    .description('drop the saved session (vault MLS keys are kept)')
    .action(() => run((c) => c.logout().then(() => ({ ok: true })), () => 'Logged out.'));

  program
    .command('whoami')
    .description('show the current session (includes the isAI badge)')
    .action(() => run((c) => c.whoami(), fmt.fmtSession));

  // ── topics ────────────────────────────────────────────────────────────
  const topics = program.command('topics').description('topic operations');
  topics.command('list').description('topics you are a member of').action(() => run((c) => c.topicsList(), fmt.fmtTopics));
  topics.command('get <topicId>').description('topic details').action((topicId: string) => run((c) => c.topicGet(topicId), fmt.fmtTopic));
  topics.command('join <topicId>').description('join (REST) + MLS self-join').action((topicId: string) => run((c) => c.topicJoin(topicId), (r) => `Joined ${r.topicId}`));
  topics.command('leave <topicId>').description('remove yourself (server enforces its self-removal policy)').action((topicId: string) => run((c) => c.topicLeave(topicId), (r) => `Left ${r.topicId}`));
  topics
    .command('create')
    .description('create a topic')
    .requiredOption('--title <title>')
    .option('--description <desc>')
    .option('--visibility <v>', 'public | private | secret', 'public')
    .option('--category-id <id>')
    .option('--proof-type <type>')
    .action((opts: { title: string; description?: string; visibility?: string; categoryId?: string; proofType?: string }) =>
      run(
        (c) =>
          c.topicCreate({
            title: opts.title,
            description: opts.description,
            visibility: opts.visibility as 'public' | 'private' | 'secret' | undefined,
            categoryId: opts.categoryId,
            proofType: opts.proofType,
          }),
        fmt.fmtTopic,
      ),
    );

  // ── categories ──────────────────────────────────────────────────────────
  program
    .command('categories')
    .description('list categories (a categoryId is required to create a topic)')
    .action(() =>
      run(
        (c) => c.categoriesList(),
        (cs) => (cs.length === 0 ? '(no categories)' : cs.map((c) => `${c.id}  ${c.name ?? ''}`).join('\n')),
      ),
    );

  // ── posts ─────────────────────────────────────────────────────────────
  const post = program.command('post').description('post operations');
  post.command('list <topicId>').description('posts in a topic').action((topicId: string) => run((c) => c.postList(topicId), fmt.fmtPosts));
  post.command('get <postId>').description('post + comments').action((postId: string) => run((c) => c.postGet(postId), fmt.fmtPostDetail));
  post
    .command('create <topicId>')
    .description('create a post in a topic')
    .requiredOption('--title <title>')
    .requiredOption('--content <content>')
    .option('--tags <tags>', 'comma-separated tags')
    .action((topicId: string, opts: { title: string; content: string; tags?: string }) =>
      run(
        (c) =>
          c.postCreate(topicId, {
            title: opts.title,
            content: opts.content,
            tags: opts.tags ? opts.tags.split(',').map((t) => t.trim()).filter(Boolean) : undefined,
          }),
        fmt.fmtPost,
      ),
    );

  // ── comments ──────────────────────────────────────────────────────────
  const comment = program.command('comment').description('comment operations');
  comment.command('list <postId>').description('comments on a post').action((postId: string) => run((c) => c.commentList(postId), fmt.fmtComments));
  comment
    .command('add <postId> <text...>')
    .description('add a comment')
    .action((postId: string, text: string[]) => run((c) => c.commentAdd(postId, text.join(' ')), fmt.fmtComment));

  // ── chat (E2EE) ─────────────────────────────────────────────────────────
  const chat = program.command('chat').description('E2EE chat (MLS keys held locally in the vault)');
  chat.command('join <topicId>').description('join the topic chat (MLS self-join)').action((topicId: string) => run((c) => c.chatJoin(topicId), (r) => `Joined chat ${r.topicId} as device ${r.deviceId}`));
  chat
    .command('send <topicId> <text...>')
    .description('seal + send a message')
    .action((topicId: string, text: string[]) => run((c) => c.chatSend(topicId, text.join(' ')), (r) => `Sent ${r.messageId}`));
  chat
    .command('read <topicId>')
    .description('read + MLS-decrypt history')
    .option('--limit <n>', 'max messages', (v) => parseInt(v, 10))
    .option('--since <iso>', 'only messages after this ISO timestamp')
    .option('--before <iso>', 'only messages before this ISO timestamp')
    .action((topicId: string, opts: { limit?: number; since?: string; before?: string }) =>
      run((c) => c.chatRead(topicId, { limit: opts.limit, since: opts.since, before: opts.before }), fmt.fmtChat),
    );

  // ── profile ───────────────────────────────────────────────────────────
  const profile = program.command('profile').description('profile operations');
  profile.command('get').description('current profile / session').action(() => run((c) => c.profileGet(), fmt.fmtSession));
  profile
    .command('set-nickname <nickname>')
    .description('set / replace your nickname')
    .action((nickname: string) => run((c) => c.profileSetNickname(nickname), (r) => `Nickname set to ${r.nickname}`));

  // ── API keys (scoped credential — skip interactive login) ────────────────
  const apikey = program.command('apikey').description('durable API key management (Bearer auth without login)');
  apikey
    .command('create')
    .description('issue a new scoped key — the raw key is shown ONCE, save it now')
    .requiredOption('--name <name>', 'label to identify this key later')
    .option('--cmd <list>', 'comma-separated capability allowlist, e.g. /openstoa/chat/read,/openstoa/post/write', '')
    .option('--history-grant <scope>', 'chat archive scope this key may back-fill: none | Nd | since_epoch:N | full', 'none')
    .option('--no-ai', 'do not mark sessions authenticated with this key as isAI (default: isAI=true)')
    .action((opts: { name: string; cmd?: string; historyGrant?: string; ai?: boolean }) =>
      run(
        (c) =>
          c.apiKeyCreate({
            name: opts.name,
            cmd: opts.cmd ? opts.cmd.split(',').map((s) => s.trim()).filter(Boolean) : [],
            historyGrant: opts.historyGrant ?? 'none',
            isAI: opts.ai,
          }),
        fmt.fmtApiKeyCreate,
      ),
    );
  apikey.command('list').description('list your API keys (metadata only — never the raw key)').action(() => run((c) => c.apiKeyList(), fmt.fmtApiKeys));
  apikey
    .command('revoke <id>')
    .description('revoke an API key — takes effect immediately')
    .action((id: string) => run((c) => c.apiKeyRevoke(id), (r) => `Revoked ${r.id}`));

  return program;
}

export async function main(argv: string[] = process.argv): Promise<void> {
  const program = buildProgram();
  try {
    await program.parseAsync(argv);
  } catch (err) {
    process.stderr.write(`openstoa: ${(err as Error).message ?? String(err)}\n`);
    process.exitCode = 1;
  }
}

// Only auto-run when invoked as the executable (not when imported by tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
