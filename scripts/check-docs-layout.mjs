// Run against a built app: DOCS_BASE_URL=http://localhost:3200 node scripts/check-docs-layout.mjs
// Set PLAYWRIGHT_CHANNEL=chromium to use Playwright's bundled browser instead of Chrome.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const baseURL = process.env.DOCS_BASE_URL || 'http://localhost:3200';
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' });
let checked = 0;
try {
  for (const locale of ['ko', 'en']) {
    const context = await browser.newContext();
    await context.addCookies([{ name: 'NEXT_LOCALE', value: locale, url: baseURL }]);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    for (const width of [390, 768, 1024, 1440, 1920]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const path of ['/docs?topic=topics#topics', '/docs/tiers', '/docs?topic=intro#intro']) {
        const label = `${locale} ${width}px ${path}`;
        const response = await page.goto(new URL(path, baseURL).href, { waitUntil: 'networkidle' });
        assert.equal(response.status(), 200, label);
        const layout = await page.evaluate(() => {
          const tiers = [...document.querySelectorAll('[data-testid^="tier-row-"]')];
          // Check nested containers too: document width alone missed the original bug.
          const elements = new Set();
          for (const tier of tiers) {
            for (let node = tier; node; node = node.parentElement) elements.add(node);
            tier.querySelectorAll('*').forEach(node => elements.add(node));
          }
          return {
            pageOverflow: document.documentElement.scrollWidth > innerWidth + 1,
            internalOverflow: [...elements].filter(node => node.clientWidth > 0 && node.scrollWidth > node.clientWidth + 1).map(node => node.tagName),
            // A long summary needs a readable line, not a one-character-wide column.
            summaryWidths: tiers.map(tier => (tier.querySelector('header p') || tier.querySelector('th div:last-child'))?.getBoundingClientRect().width || 0),
            articleWidth: document.querySelector('[data-docs-topic]')?.getBoundingClientRect().width,
          };
        });
        assert.equal(layout.pageOverflow, false, `${label}: page overflow`);
        assert.deepEqual(layout.internalOverflow, [], `${label}: comparison overflow`);
        if (!path.includes('intro')) {
          assert.equal(layout.summaryWidths.length, 4, label);
          assert.ok(layout.summaryWidths.every(value => value >= 240), `${label}: compressed summaries ${layout.summaryWidths}`);
        }
        if (width === 1920 && layout.articleWidth) assert.ok(layout.articleWidth >= 1200, `${label}: unused desktop space`);
        checked++;
      }
    }
    assert.deepEqual(errors, [], `${locale}: browser errors`);
    await context.close();
  }
  console.log(`PASS: ${checked} documentation layouts, both languages, 390–1920px; no page or comparison overflow.`);
} finally {
  await browser.close();
}
