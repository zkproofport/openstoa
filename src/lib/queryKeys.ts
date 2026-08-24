/**
 * Cache keys, shared with the mini-app.
 *
 * A thin re-export, matching how this codebase already reaches shared code
 * (`src/lib/chatMedia.ts` → `packages/mls/src/chatMedia`). The keys themselves
 * live beside the response types in `@openstoa/api-types`, because a key is
 * part of the API contract: `['topic', id]` is a claim about what the server
 * treats as one resource, and two clients disagreeing about it means an
 * invalidation written for one silently misses the other.
 */
export * from '../../packages/api-types/src/queryKeys';
