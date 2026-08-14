import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { leafIdentity, userIdOfLeaf, deviceIdOfLeaf, leafBelongsTo } from '@/lib/mls/leafIdentity';

const USER = '0x4a707ea4fc8031f35fcc7a0f8a1f478922e99ea32ecd30aec302a18087c29a25';
const DEVICE = 'web-3f1c2e00-9a55-4b21-8c0d-77e2a1b4c6f9';

/**
 * This is what makes removal complete: an admin reads the tree and finds every
 * leaf an account owns. Get it wrong in one direction and a removed member
 * keeps a device in the group; get it wrong in the other and an innocent member
 * is evicted.
 */
describe('leafIdentity', () => {
  it('round-trips both halves', () => {
    const id = leafIdentity(USER, DEVICE);
    expect(userIdOfLeaf(id)).toBe(USER);
    expect(deviceIdOfLeaf(id)).toBe(DEVICE);
  });

  it('splits on the FIRST separator, so a device id containing one survives', () => {
    // Device ids are client-generated; nothing stops one carrying a colon, and
    // splitting on the last would silently reassign the leaf to another user.
    const odd = 'web-a:b:c';
    const id = leafIdentity(USER, odd);
    expect(userIdOfLeaf(id)).toBe(USER);
    expect(deviceIdOfLeaf(id)).toBe(odd);
  });

  it('two devices of one account are both recognised as that account', () => {
    const a = leafIdentity(USER, 'web-1');
    const b = leafIdentity(USER, 'ios-2');
    expect(leafBelongsTo(a, USER)).toBe(true);
    expect(leafBelongsTo(b, USER)).toBe(true);
  });

  it('REGRESSION: a LEGACY identity belongs to nobody, rather than to whoever is being removed', () => {
    /*
     * Leaves created before this format carry a bare `web-<uuid>`. Guessing an
     * owner for them would evict an innocent member during a kick; refusing to
     * guess merely leaves the leaf in place. Only one of those is safe.
     */
    expect(userIdOfLeaf('web-3f1c2e00-9a55-4b21')).toBeNull();
    expect(leafBelongsTo('web-3f1c2e00-9a55-4b21', USER)).toBe(false);
  });

  it('HOSTILE: a leaf claiming another account is not matched by accident', () => {
    const other = '0xdeadbeef';
    expect(leafBelongsTo(leafIdentity(other, DEVICE), USER)).toBe(false);
  });

  it('HOSTILE: a prefix of the user id does not match it', () => {
    // `0xdead` must not match `0xdeadbeef` — string containment would.
    expect(leafBelongsTo(leafIdentity('0xdeadbeef', DEVICE), '0xdead')).toBe(false);
    expect(leafBelongsTo(leafIdentity('0xdead', DEVICE), '0xdeadbeef')).toBe(false);
  });

  it('HOSTILE: malformed identities parse to null rather than throwing', () => {
    for (const bad of ['', ':', ':device', 'user:', '::', 'nocolon']) {
      expect(userIdOfLeaf(bad), bad).toBeNull();
      expect(leafBelongsTo(bad, USER), bad).toBe(false);
    }
  });

  it('BOUNDARY: an empty user or device is refused, not stored as half an identity', () => {
    expect(userIdOfLeaf(leafIdentity('', DEVICE))).toBeNull();
    expect(userIdOfLeaf(leafIdentity(USER, ''))).toBeNull();
  });
});

describe('shared rule', () => {
  it('is BYTE-IDENTICAL to the mini-app copy, so both clients name leaves alike', () => {
    const web = readFileSync(join(process.cwd(), 'src/lib/mls/leafIdentity.ts'), 'utf8');
    const mobile = readFileSync(join(process.cwd(), 'packages/mobile/src/crypto/leafIdentity.ts'), 'utf8');
    expect(mobile).toBe(web);
  });
});
