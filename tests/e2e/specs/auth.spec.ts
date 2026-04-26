import { test, expect } from '../fixtures/auth';

test('admin session loads dashboard', async ({ adminPage }) => {
  await adminPage.goto('/dashboard');
  await expect(adminPage.getByRole('heading', { name: /대시보드/ })).toBeVisible({ timeout: 15_000 });
});
