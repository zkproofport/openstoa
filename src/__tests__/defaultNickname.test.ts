import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  defaultNickname,
  displayNickname,
  isDefaultNickname,
  isReservedNickname,
  DEFAULT_NICKNAME_PREFIX,
} from '@/lib/defaultNickname';

/** The rule the nickname route enforces — the generated name must satisfy it. */
const NICKNAME_REGEX = /^[a-zA-Z0-9_]{2,20}$/;

const NULLIFIER = '0x4a707ea4fc8031f35fcc7a0f8a1f478922e99ea32ecd30aec302a18087c29a25';

describe('defaultNickname', () => {
  it('CONTRACT: satisfies the rule a user-chosen nickname has to satisfy', () => {
    // A generated name the profile form would reject is a name the user can
    // look at but never re-save, which is how a "temporary" name becomes
    // permanent by accident.
    for (let i = 0; i < 500; i++) {
      const name = defaultNickname(`0x${i.toString(16).padStart(64, '0')}`);
      expect(name, name).toMatch(NICKNAME_REGEX);
    }
  });

  it('BOUNDARY: is exactly at the twenty-character limit, never over', () => {
    expect(defaultNickname(NULLIFIER).length).toBe(19);
  });

  it('is STABLE: the same account resolves to the same name every time', () => {
    // A retried sign-in must not mint a second identity for one nullifier.
    expect(defaultNickname(NULLIFIER)).toBe(defaultNickname(NULLIFIER));
  });

  it('CONTRACT: no shared pool, so two accounts cannot be made to collide', () => {
    /*
     * This is the whole reason the scheme is what it is. An earlier version
     * assembled names from word lists, which meant a finite pool, a retry
     * ladder — and, because the candidates were deterministic, an account whose
     * candidates were all taken could never sign in again. Deriving from the
     * nullifier inherits the nullifier's uniqueness instead.
     */
    const names = new Set<string>();
    for (let i = 0; i < 5000; i++) {
      names.add(defaultNickname(`0x${i.toString(16).padStart(64, '0')}`));
    }
    expect(names.size).toBe(5000);
  });

  it('HOSTILE: an empty or non-hex nullifier still produces a storable name', () => {
    for (const input of ['', '0x', '한글', '💥', ' ', 'zzzz', '0xAB']) {
      const name = defaultNickname(input);
      expect(name, input).toMatch(NICKNAME_REGEX);
      expect(name.length, input).toBeLessThanOrEqual(20);
    }
  });

  it('every character reaches the name — a shared PREFIX is not a shared name', () => {
    // This is what a slice got wrong: nullifiers that agree on their first
    // sixteen characters would have collided on the unique column, and the
    // second account would have failed to be created.
    const a = defaultNickname(`0x${'0'.repeat(60)}0001`);
    const b = defaultNickname(`0x${'0'.repeat(60)}0002`);
    expect(a).not.toBe(b);
  });
});

describe('displayNickname', () => {
  it('shortens a generated name — it is hex, and it crowds the message', () => {
    const full = defaultNickname(NULLIFIER);
    const shown = displayNickname(full);
    expect(shown).toBe(`${full.slice(0, 10)}…`);
    expect(shown.length).toBeLessThan(full.length);
  });

  it('REGRESSION: never shortens a name a PERSON chose', () => {
    // They picked those characters on purpose, and the limit is twenty anyway.
    expect(displayNickname('jaehyuk_hyun_dev')).toBe('jaehyuk_hyun_dev');
    expect(displayNickname('a'.repeat(20))).toBe('a'.repeat(20));
  });

  it('shortens the LEGACY default too', () => {
    expect(displayNickname('anon_a1b2c3d4')).toBe('anon_a1b2c…');
  });

  it('BOUNDARY: a short default name is left alone', () => {
    expect(displayNickname('OS_1234')).toBe('OS_1234');
  });

  it('HOSTILE: an empty name does not throw', () => {
    expect(displayNickname('')).toBe('');
  });
});

describe('isDefaultNickname', () => {
  it('recognises what it generates', () => {
    expect(isDefaultNickname(defaultNickname(NULLIFIER))).toBe(true);
  });

  it('still recognises the LEGACY prefix — those accounts exist', () => {
    expect(isDefaultNickname('anon_a1b2c3d4')).toBe(true);
  });

  it('a chosen name is not a default one', () => {
    expect(isDefaultNickname('jaehyuk')).toBe(false);
    expect(isDefaultNickname('OpenStoa_Team')).toBe(false);
  });
});

describe('isReservedNickname', () => {
  it('holds back the project prefix', () => {
    expect(isReservedNickname('OpenStoa')).toBe(true);
    expect(isReservedNickname('OpenStoa_Team')).toBe(true);
  });

  it('HOSTILE: case does not get around it', () => {
    // `openstoa_admin` impersonates exactly as well as `OpenStoa_Admin`.
    expect(isReservedNickname('openstoa_admin')).toBe(true);
    expect(isReservedNickname('OPENSTOA')).toBe(true);
    expect(isReservedNickname('OpEnStOa_x')).toBe(true);
  });

  it('does NOT hold back the generated shape — only the project prefix', () => {
    // The column is unique, so a person taking an OS_-looking name costs
    // nobody anything.
    expect(isReservedNickname(defaultNickname(NULLIFIER))).toBe(false);
    expect(isReservedNickname('OS_Anything')).toBe(false);
  });

  it('a name that merely CONTAINS the word is fine', () => {
    expect(isReservedNickname('i_love_openstoa')).toBe(false);
  });
});

describe('shared rule', () => {
  it('is BYTE-IDENTICAL to the mini-app copy, so both clients show the same name', () => {
    const web = readFileSync(join(process.cwd(), 'src/lib/defaultNickname.ts'), 'utf8');
    const mobile = readFileSync(join(process.cwd(), 'packages/mobile/src/lib/defaultNickname.ts'), 'utf8');
    expect(mobile).toBe(web);
  });
});
