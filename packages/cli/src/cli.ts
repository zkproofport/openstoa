/**
 * `openstoa` CLI. A thin commander front-end over the shared command core
 * (@masselabs/openstoa-commands). NO business logic lives here — every action
 * resolves a Commands instance and calls one of its methods, so the CLI and the
 * MCP server stay in lockstep. `--json` emits the raw structured result.
 */
import { Command, Option } from 'commander';
import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { createCommands, isEntrypoint, type Commands, type CommandConfig } from '@masselabs/openstoa-commands';
import * as fmt from './format';

/** Map a file extension to an image MIME type for `upload` (server accepts image/* only). */
const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
};

export type CommandsFactory = (config: CommandConfig) => Promise<Commands>;
const defaultFactory: CommandsFactory = (config) => createCommands(config);

/**
 * Error surfaced for `openstoa login` / `login --google`. The interactive Google
 * device flow is disabled because it depends on the ZKProofport AI prover
 * (ai.zkproofport.app), which is offline. Exported so the tests assert the exact
 * user-facing guidance rather than a substring of a duplicated literal.
 */
export const DEVICE_LOGIN_DISABLED =
  'Interactive Google login is temporarily unavailable (the ZKProofport prover service is offline). ' +
  'Use a scoped API key instead: set OPENSTOA_API_KEY (or --api-key <key>, or ~/.openstoa/credentials), ' +
  'or adopt an existing Bearer with `openstoa login --token <jwt>`.\n' +
  'To get your first key: sign in to the OpenStoa web site with the ZKProofport mobile app, ' +
  'then open /my → AI agents → create an API key. From an already-authenticated session you can also run ' +
  '`openstoa apikey create --name <label>`.';

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
  // A scoped API key (--api-key / OPENSTOA_API_KEY / ~/.openstoa/credentials) is
  // THE auth path: it short-circuits login entirely. `--token` adopts a Bearer
  // minted elsewhere. `--dev` is a hidden dev-only escape hatch (the server
  // returns 404 in production).
  //
  // TEMPORARILY DISABLED — the interactive Google device flow. It calls the
  // ZKProofport AI prover (ai.zkproofport.app), which is offline (shut down for
  // cost), so it can only fail. `--google` stays registered so `login --help`
  // explains the situation instead of silently dropping the option. To restore:
  // bring the prover back up, then uncomment `deviceLogin.ts` + the commands-core
  // block + this action's device path + the MCP openstoa_authenticate tool.
  program
    .command('login')
    .description('adopt an existing Bearer with --token; API keys (OPENSTOA_API_KEY / --api-key) need no login')
    .option('--google', 'TEMPORARILY UNAVAILABLE: interactive Google device-flow login (prover service offline)')
    .option('--token <jwt>', 'adopt an externally-obtained Bearer (e.g. an AI verify token)')
    .addOption(new Option('--dev', 'DEV ONLY: dev-login (dev/staging; server returns 404 in production)').hideHelp())
    .addOption(new Option('--nickname <name>', 'nickname for a fresh --dev dev-login user').hideHelp())
    .action((opts: { google?: boolean; token?: string; dev?: boolean; nickname?: string }) => {
      if (opts.token) {
        return run((c) => c.login({ token: opts.token }), fmt.fmtLogin);
      }
      if (opts.dev) {
        // Hidden dev-login path — still usable locally/staging for tests; the
        // server returns 404 in production, surfaced as a clear error.
        return run((c) => c.login({ nickname: opts.nickname }), fmt.fmtLogin);
      }
      // Bare `login` and `--google` both land here: fail fast with the API-key
      // guidance instead of attempting a device flow that cannot succeed.
      throw new Error(DEVICE_LOGIN_DISABLED);
    });

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
  topics
    .command('join <topicId>')
    .description('join (REST) + MLS self-join; pass a proof for gated topics')
    .option('--proof <hex>', 'ZK proof bytes for a proof-gated topic (KYC / country / workspace)')
    .option('--public-inputs <hex>', 'ZK proof public inputs (required alongside --proof)')
    .action((topicId: string, opts: { proof?: string; publicInputs?: string }) =>
      run(
        (c) => c.topicJoin(topicId, { proof: opts.proof, publicInputs: opts.publicInputs }),
        (r) => (r.pending ? `Join request pending approval for ${r.topicId}` : `Joined ${r.topicId}`),
      ),
    );
  topics.command('leave <topicId>').description('remove yourself (server enforces its self-removal policy)').action((topicId: string) => run((c) => c.topicLeave(topicId), (r) => `Left ${r.topicId}`));
  topics
    .command('members <topicId>')
    .description('list a topic’s members')
    .action((topicId: string) =>
      run((c) => c.topicMembers(topicId), (ms) => (ms.length === 0 ? '(no members)' : ms.map((m) => `${m.userId}  ${m.nickname ?? ''}`).join('\n'))),
    );
  topics
    .command('update <topicId>')
    .description('edit a topic you own')
    .option('--title <title>')
    .option('--description <desc>')
    .option('--visibility <v>', 'public | private | secret')
    .option('--category-id <id>')
    .option('--proof-type <type>')
    .action((topicId: string, opts: { title?: string; description?: string; visibility?: string; categoryId?: string; proofType?: string }) =>
      run(
        (c) =>
          c.topicUpdate(topicId, {
            title: opts.title,
            description: opts.description,
            visibility: opts.visibility as 'public' | 'private' | 'secret' | undefined,
            categoryId: opts.categoryId,
            proofType: opts.proofType,
          }),
        fmt.fmtTopic,
      ),
    );
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

  post
    .command('update <postId>')
    .description('edit a post you authored')
    .option('--title <title>')
    .option('--content <content>')
    .option('--tags <tags>', 'comma-separated tags')
    .action((postId: string, opts: { title?: string; content?: string; tags?: string }) =>
      run(
        (c) =>
          c.postUpdate(postId, {
            title: opts.title,
            content: opts.content,
            tags: opts.tags ? opts.tags.split(',').map((t) => t.trim()).filter(Boolean) : undefined,
          }),
        fmt.fmtPost,
      ),
    );
  post.command('delete <postId>').description('delete a post you authored').action((postId: string) => run((c) => c.postDelete(postId), (r) => `Deleted ${r.id}`));

  // ── comments ──────────────────────────────────────────────────────────
  const comment = program.command('comment').description('comment operations');
  comment.command('list <postId>').description('comments on a post').action((postId: string) => run((c) => c.commentList(postId), fmt.fmtComments));
  comment
    .command('add <postId> <text...>')
    .description('add a comment')
    .action((postId: string, text: string[]) => run((c) => c.commentAdd(postId, text.join(' ')), fmt.fmtComment));
  comment
    .command('delete <commentId>')
    .description('soft-delete a comment (author, or topic owner/admin)')
    .action((commentId: string) => run((c) => c.commentDelete(commentId), (r) => `Deleted comment ${r.commentId}`));

  // ── upload (image → CDN public URL) ─────────────────────────────────────
  program
    .command('upload <file>')
    .description('upload an image file to the CDN; prints the public URL to embed')
    .option('--purpose <p>', 'post | topic | avatar', 'post')
    .option('--content-type <mime>', 'override the MIME type (else inferred from the file extension)')
    .action((file: string, opts: { purpose?: string; contentType?: string }) =>
      run(
        (c) => {
          const data = new Uint8Array(readFileSync(file));
          const contentType = opts.contentType ?? IMAGE_MIME[extname(file).toLowerCase()];
          if (!contentType) throw new Error(`cannot infer image MIME type from '${file}'; pass --content-type`);
          return c.uploadImage({
            data,
            filename: basename(file),
            contentType,
            purpose: opts.purpose as 'post' | 'topic' | 'avatar' | undefined,
          });
        },
        (r) => r.publicUrl,
      ),
    );

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

  // ── dm (1:1 direct chat — E2EE, reuses the chat stack) ────────────────────
  const dm = program.command('dm').description('1:1 direct messages (E2EE; a hidden 2-member topic)');
  dm
    .command('start <userId>')
    .description('start or get a DM with a user (idempotent → same topic)')
    .action((userId: string) => run((c) => c.dmStart(userId), (r) => `DM topic ${r.topicId}`));
  dm.command('list').description('your DM channels').action(() => run((c) => c.dmList(), fmt.fmtDms));
  dm
    .command('send <topicId> <text...>')
    .description('seal + send a message in a DM')
    .action((topicId: string, text: string[]) => run((c) => c.dmSend(topicId, text.join(' ')), (r) => `Sent ${r.messageId}`));
  dm
    .command('read <topicId>')
    .description('read + MLS-decrypt DM history')
    .option('--limit <n>', 'max messages', (v) => parseInt(v, 10))
    .option('--since <iso>', 'only messages after this ISO timestamp')
    .option('--before <iso>', 'only messages before this ISO timestamp')
    .action((topicId: string, opts: { limit?: number; since?: string; before?: string }) =>
      run((c) => c.dmRead(topicId, { limit: opts.limit, since: opts.since, before: opts.before }), fmt.fmtChat),
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
    // Both flags are required: the server REPLACES the scope, so accepting just
    // one would silently reset the other (see Commands.apiKeyUpdate).
    .command('update <id>')
    .description('re-scope an existing key in place — the holder keeps the same secret')
    .requiredOption('--cmd <list>', 'comma-separated capability allowlist — replaces the old one; pass "" to remove all')
    .requiredOption('--history-grant <scope>', 'chat archive scope: none | Nd | since_epoch:N | full — replaces the old one')
    .action((id: string, opts: { cmd: string; historyGrant: string }) =>
      run(
        (c) =>
          c.apiKeyUpdate(id, {
            cmd: opts.cmd ? opts.cmd.split(',').map((s) => s.trim()).filter(Boolean) : [],
            historyGrant: opts.historyGrant,
          }),
        (k) => `Updated ${k.id}: cmd=[${k.cmd.join(', ')}] historyGrant=${k.historyGrant}`,
      ),
    );
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
// isEntrypoint resolves argv[1] through the npm bin symlink — see its docs.
if (isEntrypoint(import.meta.url, process.argv[1])) {
  void main();
}
