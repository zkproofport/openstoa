/** Independent wire fixtures: expected REST contracts are taken from route handlers,
 * not generated from the operation catalogue under test. CLI/MCP reuse these vectors. */
export interface OperationContract {
  id: string; cli: string[]; method: string; path: string;
  input: Record<string, unknown>; query?: Record<string, string>; body?: Record<string, unknown>;
}
const topic = '11111111-1111-4111-8111-111111111111';
const post = '22222222-2222-4222-8222-222222222222';
export const OPERATION_CONTRACTS: OperationContract[] = [
  { id: 'upload_delete', cli: ['upload-delete', '--urls', '/api/media/users/u1/a.png,/api/media/users/u1/b.png'], method: 'DELETE', path: '/api/upload', input: { urls: ['/api/media/users/u1/a.png', '/api/media/users/u1/b.png'] }, body: { urls: ['/api/media/users/u1/a.png', '/api/media/users/u1/b.png'] } },
  { id: 'feed', cli: ['feed', '--q', '한글 %_\\ 🔒', '--limit', '5', '--offset', '0', '--sort', 'new', '--tag', 'zk', '--category', 'privacy-zk', '--view', 'my'], method: 'GET', path: '/api/feed', input: { q: '한글 %_\\ 🔒', limit: 5, offset: 0, sort: 'new', tag: 'zk', category: 'privacy-zk', view: 'my' }, query: { q: '한글 %_\\ 🔒', limit: '5', offset: '0', sort: 'new', tag: 'zk', category: 'privacy-zk', view: 'my' } },
  ...[
    ['bookmarks', ['bookmarks'], '/api/bookmarks'],
    ['activity_posts', ['activity', 'posts'], '/api/my/posts'],
    ['activity_likes', ['activity', 'likes'], '/api/my/likes'],
    ['activity_recorded', ['activity', 'recorded'], '/api/my/recorded'],
    ['activity_recorded_on_mine', ['activity', 'recorded-on-mine'], '/api/my/recorded-on-mine'],
  ].map(([id, cli, path]) => ({ id: id as string, cli: [...cli as string[], '--q', '검색', '--limit', '1', '--offset', '0'], method: 'GET', path: path as string, input: { q: '검색', limit: 1, offset: 0 }, query: { q: '검색', limit: '1', offset: '0' } })),
  { id: 'recorded', cli: ['recorded', '--limit', '100', '--offset', '2'], method: 'GET', path: '/api/recorded', input: { limit: 100, offset: 2 }, query: { limit: '100', offset: '2' } },
  { id: 'tags', cli: ['tags', '--q', 'privacy', '--topic-id', topic], method: 'GET', path: '/api/tags', input: { q: 'privacy', topicId: topic }, query: { q: 'privacy', topicId: topic } },
  { id: 'stats', cli: ['stats'], method: 'GET', path: '/api/stats', input: {} },
  { id: 'ask', cli: ['ask', '--question', '사용법은?'], method: 'POST', path: '/api/ask', input: { question: '사용법은?' }, body: { question: '사용법은?' } },
  { id: 'dm_candidates', cli: ['dm', 'candidates', '--q', '이름', '--limit', '500'], method: 'GET', path: '/api/dm/candidates', input: { q: '이름', limit: 500 }, query: { q: '이름', limit: '500' } },
  { id: 'post_vote', cli: ['post', 'vote', post, '--value', '-1'], method: 'POST', path: `/api/posts/${post}/vote`, input: { postId: post, value: -1 }, body: { value: -1 } },
  ...[
    ['post_bookmark', 'bookmark', 'POST', 'bookmark'], ['post_bookmark_status', 'bookmark-status', 'GET', 'bookmark'],
    ['post_pin', 'pin', 'POST', 'pin'], ['post_record', 'record', 'POST', 'record'],
    ['post_record_status', 'record-status', 'GET', 'record-status'], ['post_records', 'records', 'GET', 'records'],
    ['post_reactions', 'reactions', 'GET', 'reactions'], ['post_poll_unvote', 'poll-unvote', 'DELETE', 'poll/vote'],
  ].map(([id, leaf, method, suffix]) => ({ id, cli: ['post', leaf, post], method, path: `/api/posts/${post}/${suffix}`, input: { postId: post }, ...(method !== 'GET' ? { body: {} } : {}) })),
  { id: 'post_react', cli: ['post', 'react', post, '--emoji', '👍'], method: 'POST', path: `/api/posts/${post}/reactions`, input: { postId: post, emoji: '👍' }, body: { emoji: '👍' } },
  { id: 'post_poll_vote', cli: ['post', 'poll-vote', post, '--option-ids', 'a,b'], method: 'POST', path: `/api/posts/${post}/poll/vote`, input: { postId: post, optionIds: ['a', 'b'] }, body: { optionIds: ['a', 'b'] } },
  { id: 'topic_delete', cli: ['topics', 'delete', topic], method: 'DELETE', path: `/api/topics/${topic}`, input: { topicId: topic }, body: {} },
  { id: 'topic_invite', cli: ['topics', 'invite', topic, '--expires-in-hours', '24'], method: 'POST', path: `/api/topics/${topic}/invite`, input: { topicId: topic, expiresInHours: 24 }, body: { expiresInHours: 24 } },
  { id: 'topic_invite_lookup', cli: ['topics', 'invite-lookup', 'abc+def'], method: 'GET', path: '/api/topics/join/abc%2Bdef', input: { inviteCode: 'abc+def' } },
  { id: 'topic_join_invite', cli: ['topics', 'join-invite', 'abc+def', '--proof', '0xab', '--public-inputs', '0xcd'], method: 'POST', path: '/api/topics/join/abc%2Bdef', input: { inviteCode: 'abc+def', proof: '0xab', publicInputs: '0xcd' }, body: { proof: '0xab', publicInputs: '0xcd' } },
  { id: 'topic_requests', cli: ['topics', 'requests', topic, '--status', 'pending'], method: 'GET', path: `/api/topics/${topic}/requests`, input: { topicId: topic, status: 'pending' }, query: { status: 'pending' } },
  ...['approve', 'reject'].map(action => ({ id: `topic_${action}`, cli: ['topics', action, topic, '--request-id', 'req1'], method: 'PATCH', path: `/api/topics/${topic}/requests`, input: { topicId: topic, requestId: 'req1' }, body: { action, requestId: 'req1' } })),
  { id: 'topic_set_role', cli: ['topics', 'set-role', topic, '--user-id', 'u1', '--role', 'admin'], method: 'PATCH', path: `/api/topics/${topic}/members`, input: { topicId: topic, userId: 'u1', role: 'admin' }, body: { userId: 'u1', role: 'admin' } },
  { id: 'topic_kick', cli: ['topics', 'kick', topic, '--user-id', 'u1'], method: 'DELETE', path: `/api/topics/${topic}/members`, input: { topicId: topic, userId: 'u1' }, body: { userId: 'u1' } },
  { id: 'profile_badges', cli: ['profile', 'badges'], method: 'GET', path: '/api/profile/badges', input: {} },
  { id: 'profile_set_badge', cli: ['profile', 'set-badge', '--type', 'oidc_login', '--visible', 'false'], method: 'PATCH', path: '/api/profile/badges', input: { type: 'oidc_login', visible: false }, body: { type: 'oidc_login', visible: false } },
  { id: 'profile_domain_badge', cli: ['profile', 'domain-badge'], method: 'GET', path: '/api/profile/domain-badge', input: {} },
  { id: 'profile_set_domain_badge', cli: ['profile', 'set-domain-badge'], method: 'POST', path: '/api/profile/domain-badge', input: {}, body: {} },
  { id: 'profile_remove_domain_badge', cli: ['profile', 'remove-domain-badge', '--domain', 'example.org'], method: 'DELETE', path: '/api/profile/domain-badge', input: { domain: 'example.org' }, body: { domain: 'example.org' } },
  { id: 'profile_image', cli: ['profile', 'image'], method: 'GET', path: '/api/profile/image', input: {} },
  { id: 'profile_set_image', cli: ['profile', 'set-image', '--image-url', 'https://cdn.example/이미지.png'], method: 'PUT', path: '/api/profile/image', input: { imageUrl: 'https://cdn.example/이미지.png' }, body: { imageUrl: 'https://cdn.example/이미지.png' } },
  { id: 'profile_remove_image', cli: ['profile', 'remove-image'], method: 'DELETE', path: '/api/profile/image', input: {}, body: {} },
  { id: 'notifications_get', cli: ['notifications', 'get'], method: 'GET', path: '/api/push/preferences', input: {} },
  { id: 'notifications_set', cli: ['notifications', 'set', '--enabled', 'false'], method: 'PATCH', path: '/api/push/preferences', input: { enabled: false }, body: { enabled: false } },
  { id: 'notifications_topic', cli: ['notifications', 'topic', topic], method: 'GET', path: `/api/topics/${topic}/push`, input: { topicId: topic } },
  { id: 'notifications_set_topic', cli: ['notifications', 'set-topic', topic, '--muted', 'true'], method: 'PATCH', path: `/api/topics/${topic}/push`, input: { topicId: topic, muted: true }, body: { muted: true } },
  { id: 'chat_presence', cli: ['chat', 'presence', topic], method: 'GET', path: `/api/topics/${topic}/chat/presence`, input: { topicId: topic } },
  { id: 'chat_read_state', cli: ['chat', 'read-state', topic], method: 'GET', path: `/api/topics/${topic}/chat/read`, input: { topicId: topic } },
  { id: 'chat_mark_read', cli: ['chat', 'mark-read', topic, '--message-id', 'm1', '--read-at', '2026-09-18T00:00:00Z'], method: 'PUT', path: `/api/topics/${topic}/chat/read`, input: { topicId: topic, messageId: 'm1', readAt: '2026-09-18T00:00:00Z' }, body: { messageId: 'm1', readAt: '2026-09-18T00:00:00Z' } },
];
