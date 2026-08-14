// @vitest-environment jsdom
/**
 * `/docs/tiers` — the page every other surface points at when it makes a claim
 * about a room.
 *
 * The page is the long form of the same facts the banner states in one line, so
 * the risk it carries is not a layout bug: it is a table that says something
 * the code does not do. Every assertion below therefore compares a rendered
 * cell against the policy the server enforces, never against a second copy of
 * the table.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage in this file
 *   contract          → 'every tier has a row', 'the operator column is derived
 *                       from the policy, not typed', 'public says yes and is the
 *                       only one', 'copy comes from the dictionary in both
 *                       locales'
 *   result integrity  → 'the history column matches historyClaimKey',
 *                       'the access columns match tierAccess'
 *   UTF-8             → 'the Korean page renders Korean, not English'
 *   boundary          → the DM row, the tier with no posts and no later joiner
 *   authorization     → N/A: the page is public documentation and reads no
 *                       session; the honesty question is what it SAYS, not who
 *                       may see it.
 *   empty/null/undef  → N/A: the page takes no input. Fallback behaviour for a
 *                       missing/garbage tier is covered in
 *                       chatTierExplainer.test.ts.
 *   race / large      → N/A: static render, no fetch.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import enLocale from '@/lib/i18n/locales/en.json';
import koLocale from '@/lib/i18n/locales/ko.json';
import { I18nProvider } from '@/lib/i18n/I18nProvider';
import {
  TIER_ORDER,
  historyClaimKey,
  operatorCanReadChat,
  tierAccess,
} from '@/lib/chatTierExplainer';

vi.mock('@/components/Header', () => ({
  default: () => React.createElement('div', { 'data-testid': 'header' }),
}));

import TiersPage from '@/app/docs/tiers/page';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function render(locale: 'en' | 'ko' = 'en') {
  act(() => {
    root.render(
      <I18nProvider initialLocale={locale}>
        <TiersPage />
      </I18nProvider>,
    );
  });
}

const row = (tier: string) => container.querySelector(`[data-testid="tier-row-${tier}"]`);
const operatorCell = (tier: string) =>
  container.querySelector(`[data-testid="tier-operator-${tier}"]`);

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('the table', () => {
  it('CONTRACT: every tier the policy knows has a row', () => {
    render();
    for (const tier of TIER_ORDER) {
      expect(row(tier), tier).not.toBeNull();
    }
  });

  it('CONTRACT: the operator column is derived — public says yes, and it is the only one', () => {
    /*
     * The single fact this page exists to state. `public` keeps its archive key
     * on the server so a later joiner reads history immediately; the page has
     * to admit that in the same table where the other three deny it.
     */
    render();
    expect(operatorCell('public')!.textContent).toContain(enLocale.tiersPage.operator.yes);
    for (const tier of ['private', 'secret', 'dm'] as const) {
      expect(operatorCell(tier)!.textContent, tier).toContain(enLocale.tiersPage.operator.no);
    }
  });

  it('CONTRACT: each operator cell agrees with operatorCanReadChat', () => {
    render();
    for (const tier of TIER_ORDER) {
      const expected = operatorCanReadChat(tier)
        ? enLocale.tiersPage.operator.yes
        : enLocale.tiersPage.operator.no;
      expect(operatorCell(tier)!.textContent, tier).toContain(expected);
    }
  });

  it('INTEGRITY: the history column is the derived claim, tier by tier', () => {
    render();
    for (const tier of TIER_ORDER) {
      const key = historyClaimKey(tier);
      const expected = (enLocale.tiersPage.history as Record<string, string>)[key];
      expect(expected, `history copy for ${key}`).toBeTruthy();
      expect(row(tier)!.textContent, tier).toContain(expected);
    }
  });

  it('INTEGRITY: the access columns are the derived facts, tier by tier', () => {
    render();
    for (const tier of TIER_ORDER) {
      const access = tierAccess(tier);
      const find = (enLocale.tiersPage.find as Record<string, string>)[access.find];
      const join = (enLocale.tiersPage.join as Record<string, string>)[access.join];
      const posts = (enLocale.tiersPage.posts as Record<string, string>)[access.posts];
      for (const [name, copy] of [['find', find], ['join', join], ['posts', posts]] as const) {
        expect(copy, `${tier}.${name}`).toBeTruthy();
        expect(row(tier)!.textContent, `${tier}.${name}`).toContain(copy);
      }
    }
  });

  it('BOUNDARY: the DM row says nobody joins later and there are no posts', () => {
    render();
    const dm = row('dm')!.textContent ?? '';
    expect(dm).toContain(enLocale.tiersPage.history.dm);
    expect(dm).toContain(enLocale.tiersPage.posts.none);
  });

  it('chat is members-only in every tier, and the DM row says so its own way', () => {
    // The one column that does NOT vary: `GET /chat` answers 403 to a
    // non-member whatever the visibility.
    render();
    for (const tier of ['public', 'private', 'secret'] as const) {
      expect(row(tier)!.textContent, tier).toContain(enLocale.tiersPage.chatAccess);
    }
    expect(row('dm')!.textContent).toContain(enLocale.tiersPage.chatAccessDm);
  });
});

describe('the sections that answer what a table cannot', () => {
  it('CONTRACT: the retention window is described as a ceiling, not a deadline', () => {
    // The known gap in the purge: it is request-triggered, so a dormant room
    // keeps expired rows until someone opens it. Saying "30 days" without this
    // would be a guarantee the service does not make.
    render();
    const text = container.textContent ?? '';
    expect(text).toContain(enLocale.tiersPage.sections.retentionCeiling);
    expect(enLocale.tiersPage.sections.retentionCeiling.toLowerCase()).toContain('ceiling');
  });

  it('CONTRACT: losing every device without a recovery code is stated as final', () => {
    // The consequence no user guesses, and the only one that is irreversible.
    render();
    expect(container.textContent).toContain(enLocale.tiersPage.sections.devicesWarning);
    expect(enLocale.tiersPage.sections.devicesWarning.toLowerCase()).toContain('recovery code');
  });

  it('CONTRACT: the media section is honest about images sent before the change', () => {
    render();
    expect(container.textContent).toContain(enLocale.tiersPage.sections.mediaBody);
  });

  it('links back to the docs index', () => {
    render();
    const back = Array.from(container.querySelectorAll('a')).find(
      (a) => a.getAttribute('href') === '/docs',
    );
    expect(back).toBeTruthy();
  });
});

describe('locales', () => {
  it('UTF-8: the Korean page renders Korean copy, not English', () => {
    render('ko');
    const text = container.textContent ?? '';
    expect(text).toContain(koLocale.tiersPage.title);
    expect(text).not.toContain(enLocale.tiersPage.title);
    expect(text).toContain(koLocale.tiersPage.operator.yesDetail);
  });

  it('CONTRACT: every key the page derives exists in BOTH locales', () => {
    // A missing leaf renders as the raw key path — visible, but only if someone
    // looks. This fails the build instead.
    for (const [name, dict] of [['en', enLocale], ['ko', koLocale]] as const) {
      for (const tier of TIER_ORDER) {
        const access = tierAccess(tier);
        const page = dict.tiersPage as unknown as {
          find: Record<string, string>;
          join: Record<string, string>;
          posts: Record<string, string>;
          history: Record<string, string>;
          tiers: Record<string, { name: string; summary: string }>;
        };
        expect(page.find[access.find], `${name}.find.${access.find}`).toBeTruthy();
        expect(page.join[access.join], `${name}.join.${access.join}`).toBeTruthy();
        expect(page.posts[access.posts], `${name}.posts.${access.posts}`).toBeTruthy();
        expect(page.history[historyClaimKey(tier)], `${name}.history.${tier}`).toBeTruthy();
        expect(page.tiers[tier]?.name, `${name}.tiers.${tier}.name`).toBeTruthy();
        expect(page.tiers[tier]?.summary, `${name}.tiers.${tier}.summary`).toBeTruthy();
      }
    }
  });
});
