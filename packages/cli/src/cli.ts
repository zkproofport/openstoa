/**
 * `openstoa` CLI. A thin commander front-end over the shared command core
 * (@masselabs/openstoa-commands). NO business logic lives here — every action
 * resolves a Commands instance and calls one of its methods, so the CLI and the
 * MCP server stay in lockstep. `--json` emits the raw structured result.
 */
import { Command, Option } from 'commander';
import QRCode from 'qrcode';
import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { OpenStoaApiError, createCommands, isEntrypoint, REST_OPERATIONS, isProofWorkflowResult, type ProofWorkflowResult, type OperationParameter, type Commands, type CommandConfig, type CreateTopicInput, type TopicProofOptions } from '@masselabs/openstoa-commands';
import * as fmt from './format';
import { defaultProofTerminal, formatProofWorkflow, interactWithProof, waitForProof, type ProofTerminal } from './proofInteraction';

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

function strictInteger(value: string): number {
  if (!/^-?\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`Expected a whole number, received ${value}`);
  return Number(value);
}

function jsonObject(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Expected a JSON object');
  return parsed as Record<string, unknown>;
}

function jsonObjectOrNull(value: string): Record<string, unknown> | 'null' {
  // Commander replaces a parser's null result with an empty string. Decode at dispatch.
  return value === 'null' ? 'null' : jsonObject(value);
}

function parseOperationValue(parameter: OperationParameter, value: string): unknown {
  if (parameter.type === 'number') return strictInteger(value);
  if (parameter.type === 'boolean') {
    if (value !== 'true' && value !== 'false') throw new Error(`${parameter.name} must be true or false`);
    return value === 'true';
  }
  if (parameter.type === 'strings') return value.split(',').map((item) => item.trim());
  return value;
}

export type CommandsFactory = (config: CommandConfig) => Promise<Commands>;
const defaultFactory: CommandsFactory = (config) => createCommands(config);

type TopicActionOptions = TopicProofOptions & { wait?: boolean };
function topicProofOptions(options: TopicActionOptions): TopicProofOptions {
  return {
    ...(options.method !== undefined ? { method: options.method } : {}),
    ...(options.approved !== undefined ? { approved: options.approved } : {}),
    ...(options.provider !== undefined ? { provider: options.provider } : {}),
  };
}

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
  terminal: ProofTerminal = defaultProofTerminal,
): Command {
  const program = new Command();
  program
    .name('openstoa')
    .description('OpenStoa CLI — REST + E2EE chat over @masselabs/openstoa (same core as the MCP server)')
    .option('--base-url <url>', 'OpenStoa origin (else OPENSTOA_BASE_URL, saved session, then https://www.openstoa.xyz)')
    .option('--vault-root <dir>', 'the .openstoa home dir for keys + session (default ~/.openstoa)')
    .option('--keystore <backend>', 'keystore backend: vault (default); keychain is not supported for chat')
    .option('--device-id <id>', 'stable MLS device identity override')
    .option('--api-key <key>', 'permission key used alongside a login session (else OPENSTOA_API_KEY, else ~/.openstoa/credentials)')
    .option('--json', 'machine-readable JSON output')
    .enablePositionalOptions();

  const globals = (): GlobalOpts => program.opts<GlobalOpts>();
  const config = (): CommandConfig => {
    const g = globals();
    return { baseUrl: g.baseUrl, vaultRoot: g.vaultRoot, backend: g.keystore, deviceId: g.deviceId, apiKey: g.apiKey };
  };

  async function run<T>(fn: (c: Commands) => Promise<T | ProofWorkflowResult>, human: (r: T) => string, options: TopicActionOptions & { proofControl?: boolean } = {}): Promise<void> {
    const interactive = !globals().json && terminal.isTTY();
    if (options.method === 'ai' && options.approved === true && !options.wait && !interactive) {
      throw new Error('AI proof generation requires --wait so the prover remains in this process.');
    }
    const cmds = await factory(config());
    let result:T|ProofWorkflowResult;
    try {result=await fn(cmds);} catch(error) {
      if(error instanceof OpenStoaApiError && error.status===401){
        const guidance={status:'authentication_required',methods:['app','ai'],message:'Login is required before API-key authorization. Complete proof login, then retry this operation.',next:{cli:'openstoa login',mcp:'openstoa_authenticate'}};
        write(globals().json?JSON.stringify(guidance):'Login required. Run `openstoa login`, then try this command again.');
        return;
      }
      throw error;
    }
    if (isProofWorkflowResult(result)) {
      let state = result;
      if (interactive && !options.proofControl && options.approved !== true && state.status === 'proof_required') {
        state = await interactWithProof(cmds, state, terminal, options);
      } else if (options.wait || (interactive && !options.proofControl && state.status === 'pending')) {
        state = await waitForProof(cmds, state, terminal, { openBrowser: !globals().json });
      }
      if (globals().json) write(JSON.stringify(state, null, 2));
      else if (state.status === 'completed' && !options.proofControl) write(human(state.result as T));
      else write(formatProofWorkflow(state));
      return;
    }
    write(globals().json ? JSON.stringify(result, null, 2) : human(result as T));
  }

  const proof = program.command('proof').description('continue a proof-required topic action with explicit consent');
  proof.command('continue <operationId>')
    .description('approve and start a proof; AI proving must stay in this process with --wait')
    .requiredOption('--approved', 'explicitly consent to generating the proof and resuming the saved action')
    .addOption(new Option('--method <method>').choices(['app', 'ai']).makeOptionMandatory())
    .addOption(new Option('--provider <provider>').choices(['google', 'microsoft']))
    .option('--wait', 'wait for proof completion and resume the saved action once')
    .action((operationId: string, opts: { approved: boolean; method: 'app' | 'ai'; provider?: 'google' | 'microsoft'; wait?: boolean }) => {
      if (opts.method === 'ai' && !opts.wait) throw new Error('AI proof generation requires --wait so the prover remains in this process.');
      return run(c => c.proofContinue({ operationId, method: opts.method, approved: true, ...(opts.provider ? { provider: opts.provider } : {}) }), formatProofWorkflow, { proofControl: true, wait: opts.wait });
    });
  proof.command('status <operationId>').description('read proof status without retrying the original action')
    .action((operationId: string) => run(c => c.proofStatus(operationId), formatProofWorkflow, { proofControl: true }));
  proof.command('resume <operationId>').description('resume the saved action after its proof is ready')
    .option('--wait', 'wait if proof generation is still pending')
    .action((operationId: string, opts: { wait?: boolean }) => run(c => c.proofResume(operationId), formatProofWorkflow, { proofControl: true, wait: opts.wait }));
  proof.command('cancel <operationId>').description('cancel a saved proof operation without retrying it')
    .action((operationId: string) => run(c => c.proofCancel(operationId), formatProofWorkflow, { proofControl: true }));

  // Explicit login supports mobile approval and the local AI Google device flow.
  program.command('login').description('sign in with a proof, resume a login, or adopt a session token')
    .option('--method <method>', 'proof method: app (default) or ai')
    .option('--google', 'use the AI Google device flow (same as --method ai)')
    .option('--approved', 'confirm consent to sign this client into your account')
    .option('--operation-id <id>', 'resume a saved login in this vault')
    .option('--cancel', 'cancel the saved login')
    .option('--wait', 'wait for approval and save the verified session')
    .option('--redirect-url <path>', 'same-origin page after browser login (app mode)')
    .option('--token <jwt>', 'adopt an externally obtained session')
    .addOption(new Option('--dev', 'DEV ONLY: local test login').hideHelp())
    .addOption(new Option('--nickname <name>', 'nickname for --dev').hideHelp())
    .action(async opts=>{
      if(opts.token)return run(c=>c.login({token:opts.token}),fmt.fmtLogin);
      if(opts.dev)return run(c=>c.login({nickname:opts.nickname}),fmt.fmtLogin);
      const interactive=!globals().json&&terminal.isTTY();
      let method=opts.google?'ai':opts.method;
      if(method!==undefined&&!['app','ai'].includes(method))throw new Error('method must be app or ai');
      if(method==='ai'&&opts.approved&&!opts.wait&&!interactive)throw new Error('AI login requires --wait to keep its local process running.');
      const commands=await factory(config());
      let state=await commands.authenticate({method,approved:opts.approved,operationId:opts.operationId,cancel:opts.cancel,redirectUrl:opts.redirectUrl});
      if(state.status==='consent_required'&&interactive){
        terminal.write(state.message);
        const consent=(await terminal.ask('Sign this CLI into your account? [y/N] ')).toLowerCase();
        if(!['y','yes'].includes(consent)){write('Login cancelled.');return;}
        method=method??(await terminal.ask('Proof method (app/ai): ')).toLowerCase();
        if(!['app','ai'].includes(method))throw new Error('method must be app or ai');
        state=await commands.authenticate({method,approved:true,redirectUrl:opts.redirectUrl});
      }
      let interrupted=false;
      let cancelPromise: ReturnType<typeof commands.authenticate> | undefined;
      const onInterrupt=()=>{
        interrupted=true;
        if(state.status==='pending'&&!cancelPromise) {
          cancelPromise=commands.authenticate({operationId:state.operationId,cancel:true});
          void cancelPromise.catch(()=>{});
        }
      };
      const opened=new Set<string>();
      const shown=new Set<string>();
      const showInstructions=async()=>{
        // Only actionable handoff details are printed, once; polling stays quiet.
        const details=JSON.stringify([state.deepLink,state.browserUrl,state.verificationUrl,state.userCode]);
        if(shown.has(details))return;
        shown.add(details);
        if(state.deepLink){
          terminal.write('Scan this QR code with ZKProofport to sign in. This terminal will wait for you.');
          terminal.write(await QRCode.toString(state.deepLink,{type:'terminal',small:true,errorCorrectionLevel:'L'}));
          if(state.browserUrl)terminal.write(`Or approve in your browser: ${state.browserUrl}`);
        }else if(state.verificationUrl){
          terminal.write(`Open ${state.verificationUrl}${state.userCode?` and enter ${state.userCode}`:''}`);
        }else if(state.browserUrl){
          terminal.write(`Open this page and approve login to show the QR code: ${state.browserUrl}`);
        }
      };
      process.on('SIGINT',onInterrupt);
      try{
        while(state.status==='pending'&&(opts.wait||interactive)){
          await showInstructions();
          const url=state.browserUrl??state.verificationUrl;
          if(url&&!state.deepLink&&interactive&&!opened.has(url)){opened.add(url);try{await terminal.openBrowser(url);}catch{terminal.write('Open the login URL above to continue.');}}
          if(interrupted){state=await (cancelPromise??commands.authenticate({operationId:state.operationId,cancel:true}));break;}
          await terminal.sleep(state.pollAfterMs);
          if(interrupted){state=await cancelPromise!;break;}
          try { state=await commands.authenticate({operationId:state.operationId}); }
          catch(error){if(!interrupted)throw error;}
          if(interrupted){state=await cancelPromise!;break;}
        }
      }finally{process.off('SIGINT',onInterrupt);}
      if(state.status==='pending'&&!globals().json)await showInstructions();
      if(globals().json)write(JSON.stringify(state));
      else if(state.status==='authenticated')write(`Logged in as ${state.nickname} (${state.userId}).`);
      else if(state.status!=='pending')write(state.message??`Login ${state.status}.`);
    });

  program
    .command('logout')
    .description('drop the saved session (vault MLS keys are kept)')
    .action(() => run((c) => c.logout().then(() => ({ ok: true })), () => 'Logged out.'));

  program
    .command('whoami')
    .description('show the current login identity and isAI session flag; no API key required')
    .action(() => run((c) => c.whoami(), fmt.fmtSession));

  // ── topics ────────────────────────────────────────────────────────────
  const topics = program.command('topics').description('topic operations');
  topics.command('list').description('read or search topics (default: joined topics)')
    .option('--view <view>', 'all for discovery; omit for joined topics')
    .addOption(new Option('--sort <sort>').choices(['hot', 'new', 'top', 'active']))
    .option('--category <slug>').option('--q <query>')
    .action((opts) => run((c) => c.topicsList(opts), fmt.fmtTopics));
  topics.command('get <topicId>').description('topic details').action((topicId: string) => run((c) => c.topicGet(topicId), fmt.fmtTopic));
  topics
    .command('join <topicId>')
    .description('join topic membership; missing proof starts a consent-based continuation; use chat join to initialize encryption')
    .addOption(new Option('--method <method>', 'generate a required proof with app QR or AI').choices(['app', 'ai']))
    .option('--approved', 'consent to proof generation and completion of this topic action')
    .addOption(new Option('--provider <provider>', 'account provider for a workspace proof').choices(['google', 'microsoft']))
    .option('--wait', 'wait for the app QR or AI proof, then finish this topic action')
    .option('--proof <hex>', 'ZK proof bytes for a proof-gated topic (KYC / country / workspace)')
    .option('--public-inputs <hex>', 'ZK proof public inputs (required alongside --proof)')
    .action((topicId: string, opts: { proof?: string; publicInputs?: string } & TopicActionOptions) =>
      run(
        (c) => c.topicJoin(topicId, { proof: opts.proof, publicInputs: opts.publicInputs, ...topicProofOptions(opts) }),
        (r) => (r.pending ? `Join request pending approval for ${r.topicId}` : `Joined ${r.topicId}`),
        opts,
      ),
    );
  topics.command('leave <topicId>').description('leave a topic; owners must transfer ownership first').action((topicId: string) => run((c) => c.topicLeave(topicId), (r) => `Left ${r.topicId}`));
  topics
    .command('members <topicId>')
    .description('list a topic’s members')
    .action((topicId: string) =>
      run((c) => c.topicMembers(topicId), (ms) => (ms.length === 0 ? '(no members)' : ms.map((m) => `${m.userId}  ${m.nickname ?? ''}`).join('\n'))),
    );
  topics
    .command('update <topicId>')
    .description('edit a topic you own: title, description or image')
    .option('--title <title>')
    .option('--description <desc>')
    .option('--image <url>', 'uploaded image URL; empty string removes it')
    .action((topicId: string, opts: { title?: string; description?: string; image?: string }) =>
      run((c) => c.topicUpdate(topicId, opts), fmt.fmtTopic),
    );
  topics
    .command('create')
    .description('create a topic; missing proof starts a consent-based continuation')
    .requiredOption('--title <title>')
    .option('--description <desc>')
    .addOption(new Option('--visibility <v>').choices(['public', 'private', 'secret']).default('public'))
    .option('--category-id <id>', 'required by the server; get an ID with openstoa categories')
    .addOption(new Option('--proof-type <type>').choices(['none', 'kyc', 'country', 'google_workspace', 'microsoft_365', 'workspace']))
    .option('--allowed-countries <codes>', 'comma-separated country codes')
    .option('--required-domain <domain>', 'workspace domain requirement')
    .addOption(new Option('--method <method>', 'generate a required proof with app QR or AI').choices(['app', 'ai']))
    .option('--approved', 'consent to proof generation and completion of this topic action')
    .addOption(new Option('--provider <provider>', 'account provider for a workspace proof').choices(['google', 'microsoft']))
    .option('--wait', 'wait for the app QR or AI proof, then finish this topic action')
    .option('--proof <hex>', 'creation proof when required')
    .option('--public-inputs <hex>', 'public inputs for the creation proof')
    .option('--image <url>', 'uploaded topic image URL')
    .option(
      '--chat-archive-retention-days <days>',
      'how long chat history is kept: 0 (forever, default) | 365 | 90 | 30. Set once, at creation',
    )
    .action((opts: { title: string; description?: string; visibility?: string; categoryId?: string; proofType?: CreateTopicInput['proofType']; chatArchiveRetentionDays?: string; allowedCountries?: string; requiredDomain?: string; proof?: string; publicInputs?: string; image?: string } & TopicActionOptions) =>
      run(
        (c) =>
          c.topicCreate({
            title: opts.title,
            description: opts.description,
            visibility: opts.visibility as 'public' | 'private' | 'secret' | undefined,
            categoryId: opts.categoryId,
            proofType: opts.proofType,
            allowedCountries: opts.allowedCountries?.split(',').map((value) => value.trim()),
            requiredDomain: opts.requiredDomain,
            proof: opts.proof,
            publicInputs: opts.publicInputs,
            image: opts.image,
            ...topicProofOptions(opts),
            // Commander hands over a string; the route accepts only a number and
            // refuses "30", so parse here rather than letting the server 400 on
            // a flag the user typed correctly.
            ...(opts.chatArchiveRetentionDays !== undefined && {
              chatArchiveRetentionDays: strictInteger(opts.chatArchiveRetentionDays) as 0 | 365 | 90 | 30,
            }),
          }),
        fmt.fmtTopic,
        opts,
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
  post.command('list <topicId>').description('read or search posts in a topic')
    .option('--limit <n>', 'max results 1–100', strictInteger).option('--offset <n>', 'pagination offset', strictInteger)
    .addOption(new Option('--sort <sort>').choices(['hot', 'new', 'top', 'active', 'recorded']))
    .option('--tag <slug>').option('--q <query>')
    .action((topicId: string, opts) => run((c) => c.postList(topicId, opts), fmt.fmtPosts));
  post.command('get <postId>').description('post + comments').action((postId: string) => run((c) => c.postGet(postId), fmt.fmtPostDetail));
  post
    .command('create <topicId>')
    .description('create a post in a topic')
    .requiredOption('--title <title>')
    .requiredOption('--content <content>')
    .option('--tags <tags>', 'comma-separated tags')
    .option('--media <json>', 'media object: images, videos, imageAlts', jsonObject)
    .option('--poll <json>', 'poll object: question, options, multipleChoice, closesAt; null removes a poll on update', jsonObjectOrNull)
    .action((topicId: string, opts: { title: string; content: string; tags?: string; media?: Record<string, unknown>; poll?: Record<string, unknown> | 'null' }) =>
      run(
        (c) =>
          c.postCreate(topicId, {
            title: opts.title,
            content: opts.content,
            tags: opts.tags !== undefined ? opts.tags.split(',').map((t) => t.trim()).filter(Boolean) : undefined,
            media: opts.media,
            poll: opts.poll === 'null' ? null : opts.poll,
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
    .option('--media <json>', 'media object: images, videos, imageAlts', jsonObject)
    .option('--poll <json>', 'poll object: question, options, multipleChoice, closesAt; null removes a poll on update', jsonObjectOrNull)
    .action((postId: string, opts: { title?: string; content?: string; tags?: string; media?: Record<string, unknown>; poll?: Record<string, unknown> | 'null' }) =>
      run(
        (c) =>
          c.postUpdate(postId, {
            title: opts.title,
            content: opts.content,
            tags: opts.tags !== undefined ? opts.tags.split(',').map((t) => t.trim()).filter(Boolean) : undefined,
            media: opts.media,
            poll: opts.poll === 'null' ? null : opts.poll,
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
    .description('upload an image (max 10MB); prints a media URL whose access follows its purpose and topic visibility')
    .option('--purpose <p>', 'post | topic | avatar', 'post')
    .option('--topic-id <id>', 'existing topic for post/cover images; required so post readers can access the image')
    .option('--content-type <mime>', 'override the MIME type (else inferred from the file extension)')
    .action((file: string, opts: { purpose?: string; contentType?: string; topicId?: string }) =>
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
            topicId: opts.topicId,
          });
        },
        (r) => r.publicUrl,
      ),
    );

  // ── chat (E2EE) ─────────────────────────────────────────────────────────
  const chat = program.command('chat').description('E2EE chat (MLS keys held locally in the vault)');
  chat
    .command('send-media <topicId> <file>')
    .description('send an image, end-to-end encrypted (png/jpeg/gif/webp; HEIC is refused — convert first)')
    .option('--mime <type>', 'override the type inferred from the file extension')
    .action((topicId: string, file: string, opts: { mime?: string }) =>
      run(
        async (c) => {
          // Read here rather than in the shared op: the op is also reached over
          // MCP, where there is no filesystem to read from.
          const { readFileSync } = await import('node:fs');
          const bytes = readFileSync(file);
          const mime = opts.mime ?? IMAGE_MIME[extname(file).toLowerCase()];
          if (!mime) throw new Error(`cannot infer image type from "${file}" — pass --mime`);
          return c.chatSendMedia(topicId, { base64: bytes.toString('base64'), mime });
        },
        (r) => `Sent ${r.mime} (${r.size} bytes) as message ${r.messageId}`,
      ),
    );
  chat.command('join <topicId>').description('join the topic chat (MLS self-join)').action((topicId: string) => run((c) => c.chatJoin(topicId), (r) => `Joined chat ${r.topicId} as device ${r.deviceId}`));
  chat
    .command('send <topicId> <text...>')
    .description('seal + send a message')
    .action((topicId: string, text: string[]) => run((c) => c.chatSend(topicId, text.join(' ')), (r) => `Sent ${r.messageId}`));
  chat
    .command('read <topicId>')
    .description('read + MLS-decrypt history')
    .option('--limit <n>', 'max messages, 1–500; server default 50', strictInteger)
    .option('--since <iso>', 'only messages after this ISO timestamp')
    .option('--before <messageId>', 'only messages before this server message ID')
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
    .option('--limit <n>', 'max messages, 1–500; server default 50', strictInteger)
    .option('--since <iso>', 'only messages after this ISO timestamp')
    .option('--before <messageId>', 'only messages before this server message ID')
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

  // Key management requires a human owner session with no selected permission key.
  // Agent sessions are denied even when no API key is attached.
  const apikey = program.command('apikey').description('manage permission keys from a human owner session without a selected API key; agent sessions are denied even without a key');
  apikey
    .command('create')
    .description('issue a new scoped key — the raw key is shown ONCE, save it now')
    .requiredOption('--name <name>', 'label to identify this key later')
    .option('--cmd <list>', 'comma-separated capability allowlist, e.g. /openstoa/chat/read,/openstoa/post/write', '')
    .option('--history-grant <scope>', 'chat archive scope this key may back-fill: none | Nd | since_epoch:N | full', 'none')
    .option('--no-ai', 'set legacy key metadata isAI=false; does not change the login session identity or grant owner access')
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

  chat.command('history <topicId>').description('decrypt the archived history available to this device and key')
    .action((topicId: string) => run((c) => c.chatHistory(topicId), fmt.fmtValue));
  dm.command('history <topicId>').description('decrypt archived DM history available to this device and key')
    .action((topicId: string) => run((c) => c.chatHistory(topicId), fmt.fmtValue));
  chat.command('share-keys <topicId>').description('share locally held history keys with existing member devices')
    .action((topicId: string) => run((c) => c.chatShareKeys(topicId), (result) => `Shared ${result.shared} key bundles`));

  // One catalogue owns the missing public REST surfaces and their exact flags.
  // Unknown fields/enums are rejected in the shared SDK before network access.
  for (const operation of REST_OPERATIONS) {
    let parent = program;
    for (const segment of operation.cli.slice(0, -1)) {
      parent = parent.commands.find((command) => command.name() === segment)
        ?? parent.command(segment).description(`${segment} operations`);
    }
    const positions = operation.parameters.filter((parameter) => parameter.location === 'path');
    const command = parent.command([operation.cli[operation.cli.length - 1], ...positions.map((parameter) => `<${parameter.name}>`)].join(' '))
      .description(`${operation.description} ${operation.access}`);
    for (const parameter of operation.parameters.filter((entry) => entry.location !== 'path')) {
      const flag = '--' + parameter.name.replace(/[A-Z]/g, (letter) => '-' + letter.toLowerCase());
      const option = new Option(`${flag} <value>`, parameter.description).argParser((value) => parseOperationValue(parameter, value));
      if (parameter.required) option.makeOptionMandatory();
      command.addOption(option);
    }
    if (operation.id === 'topic_join_invite') {
      command.addOption(new Option('--method <method>', 'generate a required proof with app QR or AI').choices(['app', 'ai']))
        .option('--approved', 'consent to proof generation and completion of this invitation join')
        .addOption(new Option('--provider <provider>').choices(['google', 'microsoft']))
        .option('--wait', 'wait for the proof and finish joining through this invitation');
    }
    command.action((...args: unknown[]) => {
      const options = args[positions.length] as Record<string, unknown>;
      const input = { ...options };
      if (operation.id === 'topic_join_invite') delete input.wait;
      positions.forEach((parameter, index) => { input[parameter.name] = args[index]; });
      return run((c) => c.executeOperation(operation.id, input), fmt.fmtValue, operation.id === 'topic_join_invite' ? options as TopicActionOptions : {});
    });
  }

  const topicHelp = '\nProof workflow: obtain consent before --approved. AI proof generation requires --wait in non-interactive/JSON mode; keep this process running. With app --wait, open the returned browser URL and scan its QR; no second terminal is needed. Existing --proof and --public-inputs must be supplied together and cannot be combined with --method, --approved or --provider. Private/secret topics require an invitation.\nDocs: https://www.openstoa.xyz/docs?topic=topics#topics';
  for (const name of ['create', 'join', 'join-invite']) topics.commands.find(c => c.name() === name)!.addHelpText('after', topicHelp);
  program.commands.find(c => c.name() === 'login')!.addHelpText('after', '\nLogin establishes identity; an API key only grants permissions for business operations. App mode displays a QR directly in this terminal; scan it with ZKProofport. The browser approval page is optional. AI login requires --wait in non-interactive/JSON mode. User consent is required before --approved. Resume/cancel using --operation-id in the same vault and server.\nDocs: https://www.openstoa.xyz/docs?topic=login#login');
  program.addHelpText('after', '\nStart with openstoa login. Business requests use the saved proof-login session plus a same-account permission key; public guest reads remain available. For command options use openstoa <command> --help.\nDocs: https://www.openstoa.xyz/docs?topic=commands#commands');
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
