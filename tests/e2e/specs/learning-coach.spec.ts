import { test, expect } from '../fixtures/auth';

const RESPONSES = [
  '트리 자료구조에서 BFS는 큐를 사용해 레벨 순회하고, DFS는 스택 또는 재귀로 깊이 우선 탐색합니다. BFS는 최단 경로 탐색에, DFS는 백트래킹 문제 해결에 적합합니다.',
  '시간 복잡도는 BFS와 DFS 모두 O(V+E)이지만 공간 복잡도가 다릅니다. BFS는 너비에 비례하는 큐를 유지하므로 O(W), DFS는 깊이에 비례하는 스택을 유지하므로 O(H)입니다.',
];

test('learning-coach: textMode 시작 → 응답 2회 → 종료', async ({ adminPage, errors }) => {
  test.setTimeout(240_000);

  // Start a session via API directly to avoid UI button text fragility,
  // then navigate to the session page with ?textMode=1
  const ctx = adminPage.context();
  const start = await ctx.request.post('/api/learning-coach/start', { data: {} });
  expect(start.ok(), `start failed: ${start.status()}`).toBeTruthy();
  const startBody = await start.json();
  const sessionId: string = startBody.session_id ?? startBody.sessionId ?? startBody.id;
  expect(sessionId).toBeTruthy();

  await adminPage.goto(`/learning-coach/session/${sessionId}?textMode=1`);

  // textMode 활성: textarea 노출로 검증
  await expect(adminPage.getByTestId('admin-text-answer-textarea')).toBeVisible({ timeout: 60_000 });

  // Submit responses
  for (let i = 0; i < RESPONSES.length; i++) {
    const textarea = adminPage.getByTestId('admin-text-answer-textarea');
    await expect(textarea).toBeVisible({ timeout: 90_000 });
    await textarea.fill(RESPONSES[i]);
    await adminPage.getByTestId('admin-text-submit').click();

    await adminPage.waitForFunction(() => {
      const ta = document.querySelector(
        '[data-testid="admin-text-answer-textarea"]'
      ) as HTMLTextAreaElement | null;
      return !ta || ta.value === '';
    }, { timeout: 90_000 });
  }

  // End session — header has a ghost button labeled "종료"
  const endBtn = adminPage.getByRole('button', { name: /종료|마치기|끝내기|완료/ });
  if ((await endBtn.count()) > 0) {
    await endBtn.first().click().catch(() => {});
  }

  // Filter noise — same approach as agent-interview
  const real = errors.filter(
    (e) => !/\/_next\/|favicon|\/api\/learning-coach\/.+\/(respond|end)/.test(e)
  );
  expect(real, `unexpected errors: ${real.join(', ')}`).toEqual([]);
});
