/**
 * The member list opened from a chat room can be left again.
 *
 * WHAT HAPPENED, driving the phone on 2026-08-28. The room's Members control
 * jumped to the Topics tab and showed the list there. The screen arrived as the
 * only route pushed on a stack it does not belong to, so the header drew no
 * back arrow — and the tab bar, the one remaining way out, cannot return anyone
 * to the conversation they were reading. A dead end, reachable in two taps.
 *
 * Pushing it on the chat stack instead is the whole fix: back goes where a
 * person expects, to the room.
 *
 * READ FROM SOURCE, deliberately. Mounting the navigator here is not possible —
 * the native stack package does not resolve in this environment — and a test
 * that mounted a stand-in navigator would be asking the stand-in, not the app.
 * Reading the two files is a narrower claim honestly made: the route is
 * registered where the room sends people, and the room sends them there.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const chatStack = read('../navigation/stacks/ChatStack.tsx');
const topicsStack = read('../navigation/stacks/TopicsStack.tsx');
const room = read('../screens/chat/ChatRoomScreen.tsx');

/** What `openMembers` does, and only that. */
const openMembers = (() => {
  const at = room.indexOf('const openMembers');
  return room.slice(at, at + 1200);
})();

describe('the member list has a way back', () => {
  it('THE DEFECT: the room sends people WITHIN its own stack', () => {
    expect(openMembers).toContain("'TopicMembers'");
    // The tab jump is what created the dead end.
    expect(openMembers).not.toContain("'TopicsTab'");
  });

  it('CONTRACT: the chat stack actually registers that route', () => {
    // Typed into the param list and never registered is exactly the shape that
    // leaves a destination unreachable, so both are checked.
    expect(chatStack).toMatch(/TopicMembers:\s*\{\s*topicId: string\s*\}/);
    expect(chatStack).toMatch(/name="TopicMembers"/);
    expect(chatStack).toContain('component={TopicMembersScreen}');
    expect(chatStack).toContain("import { TopicMembersScreen }");
  });

  it('INTEGRITY: Topics still hosts it too, for the topic detail screen', () => {
    // A different entry point with its own reason to show members; removing it
    // there would break that one instead.
    expect(topicsStack).toMatch(/name="TopicMembers"/);
  });

  it('the screen it opens is the same one in both places', () => {
    // Two registrations of two different components would drift.
    expect(chatStack).toContain('screens/topics/TopicMembersScreen');
    expect(topicsStack).toContain('screens/topics/TopicMembersScreen');
  });
});
