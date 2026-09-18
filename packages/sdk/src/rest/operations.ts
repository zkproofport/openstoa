import {authorizationForRoute} from './authorizationPolicies';
/** Browser-safe public REST operation catalogue shared by SDK, CLI, MCP and docs.
 * Internal crypto transports, device registration, site administration and owner
 * credentials are deliberately not generic agent operations. Routes remain the
 * authority for capability, membership and ownership checks. */
export interface OperationParameter {
  name: string;
  location: 'path' | 'query' | 'body';
  type: 'string' | 'number' | 'boolean' | 'strings';
  required?: boolean;
  description: string;
  choices?: readonly (string | number)[];
  min?: number;
  max?: number;
}
export interface RestOperation {
  id: string;
  cli: readonly string[];
  tool: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  description: string;
  auth: 'public' | 'session';
  availability?: 'disabled';
  access: string;
  capabilities: readonly string[];
  parameters: readonly OperationParameter[];
  body?: Readonly<Record<string, unknown>>;
}

const path = (name: string): OperationParameter => ({ name, location: 'path', type: 'string', required: true, description: name });
const query = (name: string, description: string, extra: Partial<OperationParameter> = {}): OperationParameter => ({ name, location: 'query', type: 'string', description, ...extra });
const body = (name: string, description: string, extra: Partial<OperationParameter> = {}): OperationParameter => ({ name, location: 'body', type: 'string', required: true, description, ...extra });
const paging = [query('limit', 'Maximum results (1–100; default 20)', { type: 'number', min: 1, max: 100 }), query('offset', 'Pagination offset (default 0)', { type: 'number', min: 0 })];
const search = query('q', 'Search text');
const postId = path('postId');
const topicId = path('topicId');
const op = (id: string, cli: string[], method: RestOperation['method'], route: string, description: string, parameters: OperationParameter[] = [], extra: Partial<RestOperation> = {}): RestOperation => {
 const policy=authorizationForRoute(route.replace(/\{([^}]+)\}/g,'[$1]'),method);
 const capabilities=policy?.kind==='capability'?[...(policy.all??[]),...(policy.any??[])]:[];
 return { id, cli, tool: `openstoa_${id}`, method, path: route, description, parameters, auth: 'session', access: 'Authenticated account; route authorization applies.', ...extra, capabilities };
};

export const REST_OPERATIONS: readonly RestOperation[] = [
  op('upload_delete', ['upload-delete'], 'DELETE', '/api/upload', 'Delete uploaded images owned by your account; foreign URLs are skipped.', [body('urls', 'Upload URLs (CLI: comma-separated; MCP: JSON string array)', { type: 'strings' })], { access: 'Authenticated upload owner; foreign or invalid URLs are skipped.' }),
  op('feed', ['feed'], 'GET', '/api/feed', 'Read or search the cross-topic feed.', [search, ...paging, query('sort', 'Sort order (default hot)', { choices: ['hot', 'new', 'top', 'active'] }), query('tag', 'Tag slug'), query('category', 'Category slug'), query('view', 'my limits to joined topics', { choices: ['my'] })], { auth: 'public', access: 'Guests see public topics; signed-in accounts also see joined topics.' }),
  op('bookmarks', ['bookmarks'], 'GET', '/api/bookmarks', 'Read or search your bookmarked posts.', [search, ...paging]),
  op('recorded', ['recorded'], 'GET', '/api/recorded', 'Read recorded posts across topics you have joined; use activity recorded for your own records.', paging),
  op('activity_posts', ['activity', 'posts'], 'GET', '/api/my/posts', 'Read or search your posts.', [search, ...paging]),
  op('activity_likes', ['activity', 'likes'], 'GET', '/api/my/likes', 'Read or search your liked posts.', [search, ...paging]),
  op('activity_recorded', ['activity', 'recorded'], 'GET', '/api/my/recorded', 'Read or search posts you recorded on-chain.', [search, ...paging]),
  op('activity_recorded_on_mine', ['activity', 'recorded-on-mine'], 'GET', '/api/my/recorded-on-mine', 'Read or search your posts recorded by others; sorted by record count then creation time.', [search, ...paging]),
  op('tags', ['tags'], 'GET', '/api/tags', 'Find tags, optionally within a topic.', [search, query('topicId', 'Topic ID')], { auth: 'public', access: 'Public endpoint; server visibility rules apply.' }),
  op('stats', ['stats'], 'GET', '/api/stats', 'Read community statistics.', [], { auth: 'public', access: 'Public endpoint; server visibility rules apply.' }),
  op('ask', ['ask'], 'POST', '/api/ask', 'Ask the OpenStoa assistant (currently disabled; returns HTTP 503).', [body('question', 'Question, up to 1000 characters', { max: 1000 })], { availability: 'disabled', auth: 'public', access: 'Public endpoint; server visibility rules apply.' }),
  op('dm_candidates', ['dm', 'candidates'], 'GET', '/api/dm/candidates', 'Find people sharing a topic with you to start a conversation with.', [search, query('limit', 'Maximum candidates (1–500; default 200)', { type: 'number', min: 1, max: 500 })], { capabilities: ['/openstoa/chat/read'] }),
  op('post_vote', ['post', 'vote'], 'POST', '/api/posts/{postId}/vote', 'Toggle or change a post vote; repeating the same value removes it.', [postId, body('value', '1 for upvote, -1 for downvote', { type: 'number', choices: [1, -1] })], { access: 'Signed-in users may act on public/private posts; secret topics require membership.' }),
  op('post_bookmark', ['post', 'bookmark'], 'POST', '/api/posts/{postId}/bookmark', 'Toggle a post bookmark.', [postId], { access: 'Signed-in users may act on public/private posts; secret topics require membership.' }),
  op('post_bookmark_status', ['post', 'bookmark-status'], 'GET', '/api/posts/{postId}/bookmark', 'Read your bookmark state.', [postId]),
  op('post_pin', ['post', 'pin'], 'POST', '/api/posts/{postId}/pin', 'Toggle whether a post is pinned.', [postId], { access: 'Topic owner or admin.' }),
  op('post_record', ['post', 'record'], 'POST', '/api/posts/{postId}/record', 'Record a post on-chain; eligibility and daily limits apply.', [postId], { access: 'Signed-in users may act on public/private posts; secret topics require membership. Not your own post; at least one hour old; daily limit.' }),
  op('post_record_status', ['post', 'record-status'], 'GET', '/api/posts/{postId}/record-status', 'Check on-chain recording eligibility.', [postId]),
  op('post_records', ['post', 'records'], 'GET', '/api/posts/{postId}/records', 'Read on-chain records of a post.', [postId], { auth: 'public', access: 'Public endpoint; server visibility rules apply.' }),
  op('post_react', ['post', 'react'], 'POST', '/api/posts/{postId}/reactions', 'Toggle an emoji reaction.', [postId, body('emoji', 'Reaction emoji', { choices: ['👍', '❤️', '🔥', '😂', '🎉', '😮'] })], { access: 'Signed-in users may act on public/private posts; secret topics require membership.' }),
  op('post_reactions', ['post', 'reactions'], 'GET', '/api/posts/{postId}/reactions', 'Read post reaction counts.', [postId], { auth: 'public', access: 'Public endpoint; server visibility rules apply.' }),
  op('post_poll_vote', ['post', 'poll-vote'], 'POST', '/api/posts/{postId}/poll/vote', 'Vote in a poll.', [postId, body('optionIds', 'Poll option IDs (CLI: comma-separated; MCP: JSON string array)', { type: 'strings' })], { access: 'Signed-in users may act on public/private posts; secret topics require membership. Poll must be open.' }),
  op('post_poll_unvote', ['post', 'poll-unvote'], 'DELETE', '/api/posts/{postId}/poll/vote', 'Remove your vote from an open poll.', [postId]),
  op('topic_delete', ['topics', 'delete'], 'DELETE', '/api/topics/{topicId}', 'Delete a topic as its creator/owner or a site administrator.', [topicId], { access: 'Topic owner/creator or site administrator; personal topics cannot be deleted here.' }),
  op('topic_invite', ['topics', 'invite'], 'POST', '/api/topics/{topicId}/invite', 'Create a single-use topic invite token.', [topicId, body('expiresInHours', 'Expiry in whole hours (default 168)', { type: 'number', required: false, min: 1, max: 720 })], { access: 'Any public-topic member; private/secret topics require owner or admin.' }),
  op('topic_invite_lookup', ['topics', 'invite-lookup'], 'GET', '/api/topics/join/{inviteCode}', 'Preview a topic invite.', [path('inviteCode')]),
  op('topic_join_invite', ['topics', 'join-invite'], 'POST', '/api/topics/join/{inviteCode}', 'Join a topic using an invite token. Proof-gated topics require proof and publicInputs generated for the account-bound scope from an authenticated challenge request, or a matching verified cache. Then use chat join to initialize local encryption.', [path('inviteCode'), body('proof', 'ZK proof bytes as a 0x-prefixed hex string', { required: false }), body('publicInputs', 'ZK proof public inputs as a packed 0x-prefixed hex string (required alongside proof)', { required: false })]),
  op('topic_requests', ['topics', 'requests'], 'GET', '/api/topics/{topicId}/requests', 'List legacy topic join requests.', [topicId, query('status', 'Request status (default pending)', { choices: ['pending', 'all'] })], { access: 'Topic owner or admin.' }),
  op('topic_approve', ['topics', 'approve'], 'PATCH', '/api/topics/{topicId}/requests', 'Approve a legacy topic join request; the requester must already have matching trusted verification for proof-gated topics. The approver cannot submit proof on their behalf.', [topicId, body('requestId', 'Request ID')], { body: { action: 'approve' }, access: 'Topic owner or admin.' }),
  op('topic_reject', ['topics', 'reject'], 'PATCH', '/api/topics/{topicId}/requests', 'Reject a legacy topic join request.', [topicId, body('requestId', 'Request ID')], { body: { action: 'reject' }, access: 'Topic owner or admin.' }),
  op('topic_set_role', ['topics', 'set-role'], 'PATCH', '/api/topics/{topicId}/members', 'Change a member role or transfer ownership.', [topicId, body('userId', 'Member user ID'), body('role', 'New role', { choices: ['owner', 'admin', 'member'] })], { access: 'Topic owner; cannot change your own role.' }),
  op('topic_kick', ['topics', 'kick'], 'DELETE', '/api/topics/{topicId}/members', 'Remove a member; use topics leave for yourself.', [topicId, body('userId', 'Member user ID')], { capabilities: ['/openstoa/topic/leave'], access: 'Topic owner or admin; admins can only remove members.' }),
  op('profile_badges', ['profile', 'badges'], 'GET', '/api/profile/badges', 'Read your verification and public badge state.', [], { capabilities: ['/openstoa/profile/read'] }),
  op('profile_set_badge', ['profile', 'set-badge'], 'PATCH', '/api/profile/badges', 'Choose whether to show a verified badge publicly.', [body('type', 'Badge type', { choices: ['kyc', 'country', 'oidc_domain', 'oidc_login'] }), body('visible', 'true to show, false to hide', { type: 'boolean' })], { capabilities: ['/openstoa/profile/edit'] }),
  op('profile_domain_badge', ['profile', 'domain-badge'], 'GET', '/api/profile/domain-badge', 'Read the currently verified organization domain if its badge is public.', [], { capabilities: ['/openstoa/profile/read'] }),
  op('profile_set_domain_badge', ['profile', 'set-domain-badge'], 'POST', '/api/profile/domain-badge', 'Show the currently verified organization domain badge.', [], { capabilities: ['/openstoa/profile/edit'] }),
  op('profile_remove_domain_badge', ['profile', 'remove-domain-badge'], 'DELETE', '/api/profile/domain-badge', 'Hide the currently verified domain badge; a different domain has no effect.', [body('domain', 'Current verified domain to hide; omit to hide the current domain', { required: false })], { capabilities: ['/openstoa/profile/edit'] }),
  op('profile_image', ['profile', 'image'], 'GET', '/api/profile/image', 'Read your profile image.'),
  op('profile_set_image', ['profile', 'set-image'], 'PUT', '/api/profile/image', 'Set your profile image to a URL returned by upload.', [body('imageUrl', 'Uploaded image URL')]),
  op('profile_remove_image', ['profile', 'remove-image'], 'DELETE', '/api/profile/image', 'Remove your profile image.'),
  op('notifications_get', ['notifications', 'get'], 'GET', '/api/push/preferences', 'Read notification preferences.'),
  op('notifications_set', ['notifications', 'set'], 'PATCH', '/api/push/preferences', 'Enable or disable notifications globally.', [body('enabled', 'true or false', { type: 'boolean' })]),
  op('notifications_topic', ['notifications', 'topic'], 'GET', '/api/topics/{topicId}/push', 'Read a topic notification preference.', [topicId], { access: 'Topic member.' }),
  op('notifications_set_topic', ['notifications', 'set-topic'], 'PATCH', '/api/topics/{topicId}/push', 'Mute or unmute a topic.', [topicId, body('muted', 'true to mute, false to unmute', { type: 'boolean' })], { access: 'Topic member.' }),
  op('chat_presence', ['chat', 'presence'], 'GET', '/api/topics/{topicId}/chat/presence', 'Read topic presence.', [topicId], { access: 'Topic member.' }),
  op('chat_read_state', ['chat', 'read-state'], 'GET', '/api/topics/{topicId}/chat/read', 'Read your last-read cursor.', [topicId], { capabilities: ['/openstoa/chat/read'], access: 'Topic member.' }),
  op('chat_mark_read', ['chat', 'mark-read'], 'PUT', '/api/topics/{topicId}/chat/read', 'Mark a message as read (account-level cursor).', [topicId, body('messageId', 'Server message ID'), body('readAt', 'Message server createdAt as an ISO timestamp; use the returned message time, not the local read time')], { capabilities: ['/openstoa/chat/read'], access: 'Topic member.' }),
];

export function getRestOperation(id: string): RestOperation {
  const operation = REST_OPERATIONS.find((candidate) => candidate.id === id);
  if (!operation) throw new Error(`Unknown REST operation ${id}. Known: ${REST_OPERATIONS.map((item) => item.id).join(', ')}`);
  return operation;
}

/** Strict shared input validation; CLI converts textual flags before this call.
 * Unknown fields fail before HTTP so a misspelled flag never becomes a silent no-op. */
export function prepareRestOperation(id: string, input: Record<string, unknown>) {
  const operation = getRestOperation(id);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(`${id}: expected an argument object`);
  const names = new Set(operation.parameters.map((parameter) => parameter.name));
  for (const name of Object.keys(input)) if (!names.has(name)) throw new Error(`${id}: unknown argument ${name}`);
  let route = operation.path;
  const query: Record<string, string | number> = {};
  const payload: Record<string, unknown> = { ...operation.body };
  for (const parameter of operation.parameters) {
    const value = input[parameter.name];
    if (value === undefined) {
      if (parameter.required) throw new Error(`${id}: ${parameter.name} is required`);
      continue;
    }
    const label = `${id}: ${parameter.name}`;
    if (parameter.type === 'string' && (typeof value !== 'string' || (parameter.required && !value.trim()))) throw new Error(`${label} must be a non-empty string`);
    if (parameter.type === 'boolean' && typeof value !== 'boolean') throw new Error(`${label} must be a boolean`);
    if (parameter.type === 'number' && (typeof value !== 'number' || !Number.isSafeInteger(value))) throw new Error(`${label} must be a whole number`);
    if (parameter.type === 'strings' && (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string' || !item.trim()))) throw new Error(`${label} must be a non-empty string array`);
    if (parameter.choices && !parameter.choices.includes(value as string | number)) throw new Error(`${label} must be one of ${parameter.choices.join(', ')}`);
    const size = typeof value === 'number' ? value : typeof value === 'string' ? value.length : undefined;
    if (size !== undefined && parameter.min !== undefined && size < parameter.min) throw new Error(`${label} must be at least ${parameter.min}`);
    if (size !== undefined && parameter.max !== undefined && size > parameter.max) throw new Error(`${label} must be at most ${parameter.max}`);
    if (parameter.location === 'path') route = route.replace(`{${parameter.name}}`, encodeURIComponent(value as string));
    else if (parameter.location === 'query') query[parameter.name] = value as string | number;
    else payload[parameter.name] = value;
  }
  return { operation, path: route, options: { method: operation.method, query, ...(operation.method !== 'GET' && { body: payload }) } };
}
