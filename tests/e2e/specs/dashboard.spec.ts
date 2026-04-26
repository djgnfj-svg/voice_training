import { test, expect } from '../fixtures/auth';

test('dashboard loads with charts and no console errors', async ({ adminPage, errors }) => {
  await adminPage.goto('/dashboard');
  await expect(
    adminPage.getByRole('heading', { name: /대시보드/ })
  ).toBeVisible({ timeout: 15_000 });

  // recharts renders an svg.recharts-surface — wait for at least one
  await expect(adminPage.locator('svg.recharts-surface').first()).toBeVisible({
    timeout: 15_000,
  });

  const real = errors.filter((e) => !/\/_next\/|favicon|\/api\/health/.test(e));
  expect(real, `unexpected errors: ${real.join(', ')}`).toEqual([]);
});

test('history section visible on interview setup', async ({ adminPage }) => {
  await adminPage.goto('/interview/setup');
  await expect(
    adminPage.getByText(/면접 기록|기록이 없/).first()
  ).toBeVisible({ timeout: 15_000 });
});
