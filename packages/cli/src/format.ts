/**
 * Human-readable formatters for CLI output. The `--json` path bypasses these and
 * emits the raw structured result; these only make the default output readable.
 * They never print tokens or chat plaintext beyond what the user just typed/read.
 */
import type { ChatMessage, Topic, Post, Comment, SessionPayload, DmChannel } from '@masselabs/openstoa-commands';
import type { LoginResult } from '@masselabs/openstoa-commands';
import type { ApiKeyMeta, ApiKeyCreateResult } from '@masselabs/openstoa-commands';

export function fmtLogin(r: LoginResult): string {
  return `Logged in as ${r.nickname} (${r.userId})${r.isAI ? ' [AI]' : ''}`;
}

export function fmtSession(s: SessionPayload): string {
  return `${s.nickname} (${s.userId})${s.isAI ? ' [AI]' : ''}`;
}

export function fmtTopic(t: Topic): string {
  const vis = t.visibility ? ` [${t.visibility}]` : '';
  const desc = t.description ? ` — ${t.description}` : '';
  return `${t.id}  ${t.title}${vis}${desc}`;
}

export function fmtTopics(ts: Topic[]): string {
  if (ts.length === 0) return '(no topics)';
  return ts.map(fmtTopic).join('\n');
}

export function fmtPost(p: Post): string {
  const ai = p.isAI ? ' [AI]' : '';
  return `${p.id}  ${p.title}${ai}`;
}

export function fmtPosts(ps: Post[]): string {
  if (ps.length === 0) return '(no posts)';
  return ps.map(fmtPost).join('\n');
}

export function fmtPostDetail(r: { post: Post; comments: Comment[] }): string {
  const lines = [`${r.post.title}${r.post.isAI ? ' [AI]' : ''}`, '', r.post.content, ''];
  lines.push(`Comments (${r.comments.length}):`);
  for (const c of r.comments) lines.push(`  - ${c.authorId}${c.isAI ? ' [AI]' : ''}: ${c.content}`);
  return lines.join('\n');
}

export function fmtComment(c: Comment): string {
  return `${c.id}  ${c.authorId}${c.isAI ? ' [AI]' : ''}: ${c.content}`;
}

export function fmtComments(cs: Comment[]): string {
  if (cs.length === 0) return '(no comments)';
  return cs.map(fmtComment).join('\n');
}

export function fmtApiKeyCreate(r: ApiKeyCreateResult): string {
  const caps = r.key.cmd.length > 0 ? r.key.cmd.join(', ') : '(none)';
  return [
    `Created key "${r.key.name}" (${r.key.id})`,
    `  Capabilities: ${caps}`,
    `  History grant: ${r.key.historyGrant}`,
    '',
    `RAW KEY (shown once — save it now, it cannot be retrieved again):`,
    `  ${r.rawKey}`,
  ].join('\n');
}

function fmtApiKey(k: ApiKeyMeta): string {
  const status = k.revokedAt ? ' [revoked]' : '';
  const caps = k.cmd.length > 0 ? k.cmd.join(', ') : '(none)';
  return `${k.id}  ${k.name} (${k.prefix}...)${status} — ${caps}`;
}

export function fmtApiKeys(ks: ApiKeyMeta[]): string {
  if (ks.length === 0) return '(no API keys)';
  return ks.map(fmtApiKey).join('\n');
}

export function fmtDms(dms: DmChannel[]): string {
  if (dms.length === 0) return '(no direct messages)';
  return dms
    .map((d) => `${d.topicId}  ${d.peer.nickname} (${d.peer.userId})`)
    .join('\n');
}

export function fmtChat(msgs: ChatMessage[]): string {
  if (msgs.length === 0) return '(no messages)';
  return msgs
    .map((m) => {
      if (m.type !== 'message') return `  * ${m.system ?? m.type}`;
      const ai = m.isAI ? ' [AI]' : '';
      const body = m.text === null ? '(undecryptable — run chat join / backfill)' : m.text;
      return `${m.nickname}${ai}: ${body}`;
    })
    .join('\n');
}
