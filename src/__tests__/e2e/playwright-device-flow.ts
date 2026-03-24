/**
 * Playwright stealth device code automation — shared module.
 *
 * Extracted from scripts/test-device-flow.ts for reuse by both
 * the standalone script and E2E test helpers.
 */

import { chromium, type BrowserContext, type Page } from 'playwright';
import { resolve } from 'path';

const USER_DATA_DIR = resolve(__dirname, '../../../.playwright-profile');

const DEVICE_URLS = {
  google: 'https://accounts.google.com/o/oauth2/device/usercode',
  microsoft: 'https://login.microsoftonline.com/common/oauth2/deviceauth',
};

export async function createContext(): Promise<BrowserContext> {
  return chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
    viewport: { width: 1280, height: 800 },
    locale: 'en-US',
  });
}

export async function enterGoogleCode(page: Page, code: string, accountEmail?: string): Promise<void> {
  await page.goto(DEVICE_URLS.google, { waitUntil: 'networkidle' });
  console.log(`[stealth] Page loaded: ${page.url()}`);

  // Step 1: Enter device code
  const codeInput = page.locator('input[type="text"]').first();
  await codeInput.waitFor({ state: 'visible', timeout: 10000 });
  await codeInput.fill(code);
  console.log('[stealth] Code entered');

  // Step 2: Click submit (Next/계속)
  const nextButton = page.locator('button:has-text("Next"), button:has-text("계속"), button[type="submit"]').first();
  await nextButton.click();
  console.log('[stealth] Submit clicked');

  // Step 3: Handle multi-step consent flow (account selection, permissions, etc.)
  for (let step = 0; step < 5; step++) {
    await page.waitForTimeout(3000);
    const url = page.url();
    const title = await page.title();
    console.log(`[stealth] Step ${step}: ${title} (${url.slice(0, 80)}...)`);

    // Check if we reached success page
    if (url.includes('success') || title.includes('Success') || title.includes('성공')) {
      console.log('[stealth] Success page reached!');
      return;
    }

    // Try clicking any actionable button on the page
    const actionButton = page.locator([
      'button:has-text("Allow")',
      'button:has-text("허용")',
      'button:has-text("Continue")',
      'button:has-text("계속")',
      'button:has-text("Grant")',
      'button:has-text("Confirm")',
      'button:has-text("확인")',
      'button:has-text("Yes")',
      '#submit_approve_access',
      'input[type="submit"]',
    ].join(', ')).first();

    if (await actionButton.isVisible({ timeout: 3000 }).catch(() => false)) {
      await actionButton.click();
      console.log(`[stealth] Clicked action button at step ${step}`);
      continue;
    }

    // Check for account selection (by email or first available)
    let accountButton;
    if (accountEmail) {
      accountButton = page.locator(`[data-identifier="${accountEmail}"], [data-email="${accountEmail}"]`).first();
    }
    if (!accountButton || !(await accountButton.isVisible({ timeout: 1000 }).catch(() => false))) {
      accountButton = page.locator('[data-identifier], [data-email], .account-select-item, li[role="presentation"]').first();
    }
    if (await accountButton.isVisible({ timeout: 2000 }).catch(() => false)) {
      await accountButton.click();
      console.log(`[stealth] Selected account ${accountEmail || 'first'} at step ${step}`);
      continue;
    }

    // Take screenshot for debugging if stuck
    await page.screenshot({ path: `/tmp/device-flow-step-${step}.png` });
    console.log(`[stealth] No actionable element found at step ${step}, screenshot saved`);
  }

  console.log(`[stealth] Final URL: ${page.url()}`);
  console.log(`[stealth] Page title: ${await page.title()}`);
}

export async function enterMicrosoftCode(page: Page, code: string, accountEmail?: string): Promise<void> {
  await page.goto(DEVICE_URLS.microsoft, { waitUntil: 'networkidle' });
  console.log(`[stealth] Page loaded: ${page.url()}`);

  // Step 1: Enter device code
  const codeInput = page.locator('input#otc').first();
  await codeInput.waitFor({ state: 'visible', timeout: 10000 });
  await codeInput.fill(code);
  console.log('[stealth] Code entered');

  // Step 2: Click Next
  const nextButton = page.locator('input[type="submit"], button[type="submit"]').first();
  await nextButton.click();
  console.log('[stealth] Submit clicked');

  // Step 3: Handle multi-step MS flow (account selection, consent, confirmation)
  for (let step = 0; step < 8; step++) {
    await page.waitForTimeout(3000);
    const url = page.url();
    const title = await page.title();
    console.log(`[stealth] MS step ${step}: ${title} (${url.slice(0, 80)}...)`);

    // Check for completion — "You have signed in" or "close this window"
    const pageText = await page.textContent('body').catch(() => '');
    if (pageText?.includes('signed in') || pageText?.includes('close this window') ||
        pageText?.includes('로그인되었습니다') || pageText?.includes('창을 닫아도')) {
      console.log('[stealth] MS sign-in complete!');
      return;
    }

    // Try submit/continue buttons (MS uses input[type="submit"] not button)
    const submitBtn = page.locator('input[type="submit"], button[type="submit"], button:has-text("Continue"), button:has-text("계속"), button:has-text("Yes"), button:has-text("예")').first();
    if (await submitBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await submitBtn.click();
      console.log(`[stealth] Clicked submit/continue at MS step ${step}`);
      continue;
    }

    // Check for account selection tiles (by email or first)
    let accountTile;
    if (accountEmail) {
      accountTile = page.locator(`[data-test-id="${accountEmail}"], :text("${accountEmail}")`).first();
    }
    if (!accountTile || !(await accountTile.isVisible({ timeout: 1000 }).catch(() => false))) {
      accountTile = page.locator('.table[role="presentation"] td, .identity-card, [data-test-id="accountList"] > div, .row.tile').first();
    }
    if (await accountTile.isVisible({ timeout: 2000 }).catch(() => false)) {
      await accountTile.click();
      console.log(`[stealth] Selected account ${accountEmail || 'first'} at MS step ${step}`);
      continue;
    }

    // Check if we're done (no more actionable elements)
    await page.screenshot({ path: `/tmp/ms-device-flow-step-${step}.png` });
    console.log(`[stealth] No actionable element at MS step ${step}, screenshot saved`);
  }

  console.log(`[stealth] Final URL: ${page.url()}`);
  console.log(`[stealth] Page title: ${await page.title()}`);
}

export async function enterDeviceCode(provider: 'google' | 'microsoft', code: string, accountEmail?: string): Promise<void> {
  console.log(`[stealth] Opening ${provider} device flow for code: ${code} (account: ${accountEmail || 'default'})`);

  const context = await createContext();
  const page = await context.newPage();

  try {
    if (provider === 'google') {
      await enterGoogleCode(page, code, accountEmail);
    } else {
      await enterMicrosoftCode(page, code, accountEmail);
    }
    console.log('[stealth] Device code entry completed successfully');
  } catch (err) {
    console.error('[stealth] Error:', err);
    await page.screenshot({ path: '/tmp/device-flow-error.png' });
    console.error('[stealth] Screenshot saved to /tmp/device-flow-error.png');
    throw err;
  } finally {
    await context.close();
  }
}
