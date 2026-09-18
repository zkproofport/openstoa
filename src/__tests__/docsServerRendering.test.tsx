import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import Page from '@/app/docs/page';
import { I18nProvider } from '@/lib/i18n/I18nProvider';
import { DOCS_TOPICS } from '@/lib/docs/navigation';
import { translate } from '@/lib/i18n';
vi.mock('@/components/Header', () => ({ default: () => null }));

describe('docs are readable without browser JavaScript', () => {
  it.each(DOCS_TOPICS)('serves the requested $id article in initial HTML', async ({ id, label }) => {
    const page = await Page({ searchParams: Promise.resolve({ topic: id }) });
    const html = renderToStaticMarkup(<I18nProvider initialLocale="en">{page}</I18nProvider>);
    expect(html).toContain(`data-docs-topic="${id}"`);
    expect(html).not.toMatch(/href="\/docs#/);
    for (const topic of DOCS_TOPICS) expect(html).toContain(`/docs?topic=${topic.id}#${topic.id}`);
    expect(html).toContain(translate('en', `docs.${label}`));
    if (id === 'login') expect(html).toContain('OPENSTOA_API_KEY');
    if (id === 'commands') expect(html.match(/data-cli-command=/g)).toHaveLength(88);
    if (id === 'topics') expect(html).toContain('proof_required');
    if (id === 'chat') expect(html).toContain('MLS');
  });

  it.each([undefined, 'unknown', ['login', 'topics']])('falls back safely for an invalid query', async topic => {
    const page = await Page({ searchParams: Promise.resolve({ topic }) });
    const html = renderToStaticMarkup(<I18nProvider initialLocale="en">{page}</I18nProvider>);
    expect(html).toContain('data-docs-topic="intro"');
  });
});
