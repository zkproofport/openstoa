// @vitest-environment jsdom
/**
 * The retention setting as the two clients SAY it.
 *
 * The window is chosen once by an admin and quietly deletes other people's
 * history afterwards, so the copy is not decoration — it is the only way anyone
 * else learns what was chosen, and the only place the cost ("a later joiner
 * sees less") is stated. These tests hold that copy to three things: it exists
 * in both locales, it exists for every choice the rule offers, and the two
 * clients say the same thing about the same number.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage in this file
 *   contract          → 'every choice has label + desc in BOTH locales' (web and
 *                       mini-app), 'the cost of a short window is stated', 'the
 *                       notice renders dictionary copy, never a literal'
 *   empty/null/undef  → 'an absent window renders as unlimited' (undefined and
 *                       null asserted separately)
 *   hostile input     → 'a window the rule does not offer renders as unlimited,
 *                       never as a blank or a raw key'
 *   boundary          → every offered window, including the shortest, renders
 *                       its own distinct line
 *   UTF-8             → the Korean catalogue is asserted for every key
 *   authorization / race / large input → N/A: this is presentation of a number
 *                       the server has already validated.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import enWeb from '@/lib/i18n/locales/en.json';
import koWeb from '@/lib/i18n/locales/ko.json';
import enMobile from '../../packages/mobile/src/i18n/locales/en.json';
import koMobile from '../../packages/mobile/src/i18n/locales/ko.json';
import { I18nProvider } from '@/lib/i18n/I18nProvider';
import ArchiveRetentionNotice from '@/components/ArchiveRetentionNotice';
import { ARCHIVE_RETENTION_CHOICES, archiveRetentionKey } from '@/lib/archiveRetention';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(days: number | undefined | null) {
  act(() => {
    root.render(
      <I18nProvider initialLocale="en">
        <ArchiveRetentionNotice days={days} />
      </I18nProvider>,
    );
  });
  return container.textContent ?? '';
}

describe('creation copy — the choice and its cost', () => {
  const CATALOGUES = [
    ['web/en', enWeb.newTopicPage.archiveRetention] as const,
    ['web/ko', koWeb.newTopicPage.archiveRetention] as const,
    ['mobile/en', enMobile.openstoa.topicCreate.archiveRetention] as const,
    ['mobile/ko', koMobile.openstoa.topicCreate.archiveRetention] as const,
  ];

  it('CONTRACT: every offered window has a label and a description, in every catalogue', () => {
    for (const [name, dict] of CATALOGUES) {
      for (const days of ARCHIVE_RETENTION_CHOICES) {
        const key = archiveRetentionKey(days);
        const entry = (dict.options as Record<string, { label: string; desc: string }>)[key];
        expect(entry, `${name}.${key}`).toBeDefined();
        expect(entry.label.trim().length, `${name}.${key}.label`).toBeGreaterThan(0);
        expect(entry.desc.trim().length, `${name}.${key}.desc`).toBeGreaterThan(0);
      }
    }
  });

  it('CONTRACT: the cost of a short window is stated, not implied', () => {
    // The requirement this whole setting hangs on: the admin choosing 30 days
    // has to be told, in the same breath, that a later joiner sees less.
    expect(enWeb.newTopicPage.archiveRetention.cost).toMatch(/joins later sees less/i);
    expect(enMobile.openstoa.topicCreate.archiveRetention.cost).toMatch(/joins later sees less/i);
    expect(koWeb.newTopicPage.archiveRetention.cost).toContain('나중에 들어온 멤버');
    expect(koMobile.openstoa.topicCreate.archiveRetention.cost).toContain('나중에 들어온 멤버');
  });

  it('CONTRACT: both clients describe the same window the same way', () => {
    // Two catalogues drifting is how one client ends up promising a deletion
    // schedule the other does not.
    for (const days of ARCHIVE_RETENTION_CHOICES) {
      const key = archiveRetentionKey(days);
      const web = (enWeb.newTopicPage.archiveRetention.options as Record<string, { label: string }>)[key];
      const mobile = (enMobile.openstoa.topicCreate.archiveRetention.options as Record<string, { label: string }>)[key];
      expect(mobile.label, key).toBe(web.label);
    }
  });

  it('CONTRACT: the unlimited option does not promise deletion, and 30 days does', () => {
    const opts = enWeb.newTopicPage.archiveRetention.options;
    expect(opts.unlimited.desc).toMatch(/nothing is deleted/i);
    expect(opts.days30.desc).toMatch(/deleted/i);
  });
});

describe('member-facing notice', () => {
  it('BOUNDARY: every offered window renders its own line', () => {
    const seen = new Set<string>();
    for (const days of ARCHIVE_RETENTION_CHOICES) {
      const text = render(days);
      const expected = (enWeb.topicPage.archiveRetention as Record<string, string>)[
        archiveRetentionKey(days)
      ];
      expect(text, String(days)).toBe(expected);
      seen.add(text);
    }
    expect(seen.size).toBe(ARCHIVE_RETENTION_CHOICES.length);
  });

  it('EMPTY: an undefined window renders as unlimited', () => {
    // A payload from before the setting existed means "nothing is deleted" —
    // the notice must not imply a purge that is not happening.
    expect(render(undefined)).toBe(enWeb.topicPage.archiveRetention.unlimited);
  });

  it('EMPTY: a null window renders as unlimited too', () => {
    expect(render(null)).toBe(enWeb.topicPage.archiveRetention.unlimited);
  });

  it('HOSTILE: a window the rule does not offer renders as unlimited, not blank or a raw key', () => {
    for (const odd of [7, -1, 9999]) {
      const text = render(odd);
      expect(text, String(odd)).toBe(enWeb.topicPage.archiveRetention.unlimited);
      expect(text, String(odd)).not.toContain('topicPage.');
    }
  });

  it('CONTRACT: the copy comes from the dictionary, never a literal in the component', () => {
    const source = enWeb.topicPage.archiveRetention;
    render(30);
    expect(container.textContent).toBe(source.days30);
    // …and the explanation of the cost is on the element, for the reader who
    // wants to know why history stops where it does.
    const el = container.querySelector('[title]');
    expect(el?.getAttribute('title')).toBe(source.titleWindowed);
  });

  it('CONTRACT: the unlimited notice explains that a later joiner reads everything', () => {
    render(0);
    expect(container.querySelector('[title]')?.getAttribute('title')).toBe(
      enWeb.topicPage.archiveRetention.titleUnlimited,
    );
  });

  it('CONTRACT: the mini-app carries the same member-facing lines', () => {
    const web = enWeb.topicPage.archiveRetention as Record<string, string>;
    const mobile = (enMobile.openstoa as unknown as {
      topicDetail: { archiveRetention: Record<string, string> };
    }).topicDetail.archiveRetention;
    for (const days of ARCHIVE_RETENTION_CHOICES) {
      const key = archiveRetentionKey(days);
      expect(mobile[key], key).toBe(web[key]);
    }
    const koMob = (koMobile.openstoa as unknown as {
      topicDetail: { archiveRetention: Record<string, string> };
    }).topicDetail.archiveRetention;
    for (const days of ARCHIVE_RETENTION_CHOICES) {
      const key = archiveRetentionKey(days);
      expect(koMob[key]?.trim().length, `ko ${key}`).toBeGreaterThan(0);
    }
  });
});
