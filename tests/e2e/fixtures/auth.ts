import { test as base, expect, Page } from '@playwright/test';
import { bakeSessionCookie } from './session-token';

const ADMIN = {
  id: process.env.E2E_ADMIN_USER_ID ?? '',
  email: process.env.E2E_ADMIN_EMAIL ?? 'test@voiceprep.kr',
  name: 'E2E Admin',
};

interface Fixtures {
  adminPage: Page;
  errors: string[];
}

export const test = base.extend<Fixtures>({
  errors: async ({}, use) => {
    await use([]);
  },
  adminPage: async ({ browser, baseURL, errors }, use) => {
    if (!ADMIN.id) throw new Error('E2E_ADMIN_USER_ID env required');
    if (!baseURL) throw new Error('baseURL must be configured');

    const baseUrlObj = new URL(baseURL);
    const isHttps = baseUrlObj.protocol === 'https:';
    const cookieName = isHttps ? '__Secure-authjs.session-token' : 'authjs.session-token';

    const token = await bakeSessionCookie(ADMIN, cookieName);

    const ctx = await browser.newContext({ baseURL });
    await ctx.addCookies([
      {
        name: cookieName,
        value: token,
        domain: baseUrlObj.hostname,
        path: '/',
        httpOnly: true,
        secure: isHttps,
        sameSite: 'Lax',
      },
    ]);

    const page = await ctx.newPage();

    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(`[console] ${msg.text()}`);
    });
    page.on('response', (res) => {
      const url = res.url();
      if (res.status() >= 400 && !url.includes('favicon') && !url.includes('/_next/')) {
        errors.push(`[http ${res.status()}] ${url}`);
      }
    });

    await use(page);
    await ctx.close();
  },
});

export { expect };
