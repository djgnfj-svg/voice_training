import { test, expect } from '../fixtures/auth';

test('dashboard loads with no console errors', async ({ adminPage, errors }) => {
  await adminPage.goto('/dashboard');
  await expect(
    adminPage.getByRole('heading', { level: 1, name: /안녕하세요/ })
  ).toBeVisible({ timeout: 15_000 });
  await expect(adminPage.getByRole('heading', { name: /최근 활동/ })).toBeVisible();

  const real = errors.filter((e) => !/\/_next\/|favicon|\/api\/health/.test(e));
  expect(real, `unexpected errors: ${real.join(', ')}`).toEqual([]);
});

test('history section visible on interview setup', async ({ adminPage }) => {
  await adminPage.goto('/interview/setup');
  await expect(
    adminPage.getByText(/면접 기록|기록이 없/).first()
  ).toBeVisible({ timeout: 15_000 });
});
