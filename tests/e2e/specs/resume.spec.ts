import { test, expect } from '../fixtures/auth';

test('resume: 목록 API + UI 노출', async ({ adminPage, errors }) => {
  const ctx = adminPage.context();

  // List via API (auth session attached automatically)
  const list = await ctx.request.get('/api/resume');
  expect(list.ok(), `list failed: ${list.status()}`).toBeTruthy();
  const body = await list.json();
  const items = Array.isArray(body) ? body : body.resumes ?? body.data ?? [];
  expect(Array.isArray(items)).toBeTruthy();

  // UI surface
  await adminPage.goto('/interview/setup?tab=resume');
  // Either resumes are listed or empty-state text shows
  await expect(
    adminPage.getByText(/이력서|등록된 이력서가 없|업로드/).first()
  ).toBeVisible({ timeout: 15_000 });

  const real = errors.filter((e) => !/\/_next\/|favicon/.test(e));
  expect(real, `unexpected errors: ${real.join(', ')}`).toEqual([]);
});
