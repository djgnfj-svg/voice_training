import { test, expect } from '../fixtures/auth';

const PAGES = [
  { path: '/dashboard', name: 'dashboard' },
  { path: '/interview/setup', name: 'interview-setup' },
  { path: '/interview/setup?tab=resume', name: 'resume-tab' },
  { path: '/learning-coach', name: 'learning-coach' },
];

for (const p of PAGES) {
  test(`visual: ${p.name}`, async ({ adminPage }, info) => {
    await adminPage.goto(p.path);
    await adminPage.waitForLoadState('networkidle');
    // Allow late layout settle (recharts mount, async data)
    await adminPage.waitForTimeout(500);

    await expect(adminPage).toHaveScreenshot(`${p.name}-${info.project.name}.png`, {
      fullPage: true,
      animations: 'disabled',
    });
  });
}
