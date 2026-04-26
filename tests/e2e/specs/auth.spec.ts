import { test, expect } from '../fixtures/auth';

test('admin session loads dashboard', async ({ adminPage }) => {
  await adminPage.goto('/dashboard');
  await expect(adminPage.getByRole('heading', { level: 1, name: /안녕하세요/ })).toBeVisible({ timeout: 15_000 });
});
