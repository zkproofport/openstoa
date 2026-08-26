/*
 * WHAT WAS WRONG. "Chat is mobile-only" was enforced by testing the request
 * path for the substrings `/chat`, `/mls/` and `/tak/`. Two chat surfaces
 * contain none of them, so a browser session — the kind the product tells the
 * user cannot chat — reached both:
 *
 *   POST /api/topics/<id>/archive   201 {"stored":true}   (wrote chat history)
 *   GET  /api/topics/<id>/archive   200                   (read it back)
 *   GET  /api/topics/<id>/keys/request  200
 *   POST /api/topics/<id>/keys/grant    400 "Valid requestId is required"
 *
 * The 400s matter as much as the 200s: reaching body validation means the gate
 * was passed and only the payload was missing. A browser could take part in
 * epoch-key delivery.
 *
 * This is the shape the substring list makes inevitable — it answers for the
 * paths someone remembered. So the test does not check the three that were
 * remembered; it walks the route directory and requires every sub-route of
 * /api/topics/[topicId] to be classified. A new route is blocked or allowed by
 * name, and an unclassified one fails here rather than shipping open.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, statSync, existsSync } from 'fs';
import { join } from 'path';
import { isChatPath } from '@/lib/chatPaths';

const TOPIC_ROUTE_DIR = join(process.cwd(), 'src/app/api/topics/[topicId]');
const ID = '11111111-2222-3333-4444-555555555555';

/** Sub-routes that carry chat or its key material. A browser gets none of them. */
const MOBILE_ONLY = [
  'chat',
  'chat/delivered',
  'chat/media',
  'chat/presence',
  'chat/read',
  'chat/subscribe',
  'mls/commit',
  'mls/group-info',
  'mls/key-packages',
  'tak/bundles',
  'tak/holder',
  'tak/root-fingerprint',
  'archive',
  'archive/root',
  'keys/grant',
  'keys/request',
];

/** Sub-routes a browser legitimately uses. Chat keys are not involved. */
const OPEN_TO_WEB = ['', 'blind', 'invite', 'join', 'leave', 'members', 'posts', 'push', 'requests'];

function routeSlugs(dir: string, prefix = ''): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  if (existsSync(join(dir, 'route.ts'))) out.push(prefix);
  for (const entry of readdirSync(dir)) {
    const child = join(dir, entry);
    if (!statSync(child).isDirectory()) continue;
    out.push(...routeSlugs(child, prefix ? `${prefix}/${entry}` : entry));
  }
  return out;
}

describe('chat stays on the phone', () => {
  it('every route under /api/topics/[topicId] is classified — a new one cannot ship unnoticed', () => {
    const onDisk = routeSlugs(TOPIC_ROUTE_DIR).sort();
    const classified = new Set([...MOBILE_ONLY, ...OPEN_TO_WEB]);
    const unclassified = onDisk.filter((slug) => !classified.has(slug));
    expect(unclassified).toEqual([]);
    // And the lists describe something real, not a set of names that drifted
    // away from the routes they were written for.
    const present = new Set(onDisk);
    expect([...MOBILE_ONLY, ...OPEN_TO_WEB].filter((s) => !present.has(s))).toEqual([]);
  });

  it.each(MOBILE_ONLY)('refuses a browser: /%s', (slug) => {
    expect(isChatPath(`/api/topics/${ID}/${slug}`)).toBe(true);
  });

  it.each(OPEN_TO_WEB)('still answers a browser: /%s', (slug) => {
    expect(isChatPath(slug ? `/api/topics/${ID}/${slug}` : `/api/topics/${ID}`)).toBe(false);
  });

  it('the four that used to slip through are named now', () => {
    for (const slug of ['archive', 'archive/root', 'keys/request', 'keys/grant']) {
      expect(isChatPath(`/api/topics/${ID}/${slug}`)).toBe(true);
    }
  });

  it('a topic id that reads like a chat segment does not open the door', () => {
    expect(isChatPath('/api/topics/chat')).toBe(false);
    expect(isChatPath('/api/topics/archive')).toBe(false);
    expect(isChatPath('/api/topics/keys/posts')).toBe(false);
  });

  it('leaves paths outside /api/topics alone', () => {
    for (const p of ['/api/feed', '/api/dm/chat', '/topics/x/chat', '/api/topics']) {
      expect(isChatPath(p)).toBe(false);
    }
  });
});
