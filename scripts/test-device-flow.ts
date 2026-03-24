#!/usr/bin/env npx tsx
/**
 * Playwright stealth test — automate Google/MS365 device code entry.
 *
 * Uses persistent browser context (user-data-dir) so Google/MS365 sessions
 * are remembered across runs. First run requires manual login in the browser;
 * subsequent runs reuse the session.
 *
 * Usage:
 *   npx tsx scripts/test-device-flow.ts google <CODE>
 *   npx tsx scripts/test-device-flow.ts microsoft <CODE>
 *
 * First-time setup (interactive):
 *   npx tsx scripts/test-device-flow.ts setup-google
 *   npx tsx scripts/test-device-flow.ts setup-microsoft
 */

import { enterDeviceCode, createContext } from '../src/__tests__/e2e/playwright-device-flow';

async function setupSession(provider: 'google' | 'microsoft'): Promise<void> {
  console.log(`[stealth] Setting up ${provider} session — log in manually in the browser window`);

  const context = await createContext();
  const page = await context.newPage();

  if (provider === 'google') {
    await page.goto('https://accounts.google.com', { waitUntil: 'domcontentloaded' });
  } else {
    await page.goto('https://myaccount.microsoft.com', { waitUntil: 'domcontentloaded' });
  }

  console.log('[stealth] Browser opened — log in manually, then close the browser window when done.');
  console.log('[stealth] Session will be saved for future runs.');

  // Keep alive until browser is closed
  await new Promise<void>((res) => {
    context.on('close', () => res());
  });
  console.log('[stealth] Session saved.');
}

// --- Main ---
const [,, command, code] = process.argv;

if (!command) {
  console.log('Usage:');
  console.log('  npx tsx scripts/test-device-flow.ts google <CODE>');
  console.log('  npx tsx scripts/test-device-flow.ts microsoft <CODE>');
  console.log('  npx tsx scripts/test-device-flow.ts setup-google');
  console.log('  npx tsx scripts/test-device-flow.ts setup-microsoft');
  process.exit(1);
}

if (command === 'setup-google') {
  setupSession('google').catch(console.error);
} else if (command === 'setup-microsoft') {
  setupSession('microsoft').catch(console.error);
} else if (command === 'google' || command === 'microsoft') {
  if (!code) {
    console.error(`Error: device code required. Usage: npx tsx scripts/test-device-flow.ts ${command} <CODE>`);
    process.exit(1);
  }
  enterDeviceCode(command, code).catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else {
  console.error(`Unknown command: ${command}`);
  process.exit(1);
}
