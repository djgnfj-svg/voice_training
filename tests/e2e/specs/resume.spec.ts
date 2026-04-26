import { test, expect } from '../fixtures/auth';
import sample from '../fixtures/sample-resume.json' with { type: 'json' };

test('resume: create via API → appears in UI list → delete', async ({ adminPage, errors }) => {
  const ctx = adminPage.context();

  // Create via API (uses session cookie automatically)
  const created = await ctx.request.post('/api/resume', {
    data: { name: 'E2E Resume', parsedData: sample },
  });
  expect(created.ok(), `create failed: ${created.status()}`).toBeTruthy();
  const body = await created.json();
  const id: string = body.id ?? body.resume?.id ?? body.data?.id;
  expect(id, 'response should contain id').toBeTruthy();

  // List in UI
  await adminPage.goto('/interview/setup?tab=resume');
  await expect(adminPage.getByText('E2E Resume')).toBeVisible({ timeout: 15_000 });

  // Cleanup via API
  const del = await ctx.request.delete(`/api/resume/${id}`);
  expect(del.ok(), `delete failed: ${del.status()}`).toBeTruthy();

  expect(errors).toEqual([]);
});
