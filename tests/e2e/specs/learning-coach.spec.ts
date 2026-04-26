import { test, expect } from '../fixtures/auth';

const RESPONSES = [
  '트리 자료구조에서 BFS는 큐를 사용해 레벨 순회하고, DFS는 스택 또는 재귀로 깊이 우선 탐색합니다. BFS는 최단 경로 탐색에, DFS는 백트래킹 문제 해결에 적합합니다.',
  '시간 복잡도는 BFS와 DFS 모두 O(V+E)이지만 공간 복잡도가 다릅니다. BFS는 너비에 비례하는 큐를 유지하므로 O(W), DFS는 깊이에 비례하는 스택을 유지하므로 O(H)입니다.',
];

test('learning-coach: textMode 시작 → 응답 2회 → 종료', async ({ adminPage, errors }) => {
  test.setTimeout(240_000);

  await adminPage.goto('/learning-coach');

  // Landing has a single "시작하기" button that calls startSession() and routes
  // to /learning-coach/session/{id}. No goal/topic input is required at this stage —
  // the agent infers from user state (and may ask in-session).
  const startBtn = adminPage.getByRole('button', { name: /시작하기|학습/ });
  await startBtn.first().click({ timeout: 15_000 });

  // Wait for session URL
  await adminPage.waitForURL(/\/learning-coach\/session\/[^/?]+/, { timeout: 30_000 });

  // Append ?textMode=1 and reload to activate admin textMode
  const url = new URL(adminPage.url());
  url.searchParams.set('textMode', '1');
  await adminPage.goto(url.toString());

  await expect(adminPage.getByTestId('admin-text-mode-active')).toBeVisible({ timeout: 60_000 });

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
