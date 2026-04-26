import { test, expect } from '../fixtures/auth';
import sample from '../fixtures/sample-resume.json' with { type: 'json' };

const ANSWERS = [
  '주문 처리 시스템에서 동시성 문제를 해결하기 위해 PostgreSQL의 SELECT FOR UPDATE를 활용했습니다. 비관적 락으로 재고 차감 충돌을 방지하면서, 인덱스 설계와 쿼리 플랜 분석으로 응답 시간을 200ms 이하로 유지했습니다.',
  'FastAPI의 의존성 주입을 활용해 데이터베이스 세션과 인증 토큰 검증 로직을 재사용 가능한 형태로 분리했습니다. Pydantic 모델로 요청/응답 검증을 일원화하고 OpenAPI 스펙도 자동 생성하여 프론트엔드 팀과의 인터페이스 협업 비용을 줄였습니다.',
  '결제 실패 시 재시도 전략을 멱등키 기반으로 설계해 중복 결제를 방지했습니다. exponential backoff와 dead-letter queue를 조합해 일시적 장애와 영구 장애를 구분 처리했고, Prometheus 메트릭으로 실패율을 모니터링했습니다.',
];

test('agent-interview: textMode으로 scan 단계 3답변 완주', async ({ adminPage, errors }) => {
  test.setTimeout(360_000);

  const ctx = adminPage.context();
  const created = await ctx.request.post('/api/resume', {
    data: { name: 'E2E Agent', parsedData: sample },
  });
  expect(created.ok(), `create failed: ${created.status()}`).toBeTruthy();
  const body = await created.json();
  const resumeId: string = body.id ?? body.resume?.id ?? body.data?.id;
  expect(resumeId).toBeTruthy();

  try {
    // Setup → start
    await adminPage.goto('/interview/setup');
    await adminPage.getByText('E2E Agent').click();
    await adminPage.getByText(/AI 코치/).click();
    await adminPage.getByRole('button', { name: /면접 시작/ }).click();

    // Mic check dialog: click any "확인" / "시작" / "다음" button if present
    const micConfirm = adminPage.getByRole('button', { name: /확인|시작|다음/ });
    try {
      await micConfirm.first().click({ timeout: 10_000 });
    } catch {
      // Dialog may auto-skip if no permission needed
    }

    // Wait for session URL
    await adminPage.waitForURL(/\/agent-interview\/session\/[^/?]+/, { timeout: 30_000 });

    // Append ?textMode=1 and reload
    const url = new URL(adminPage.url());
    url.searchParams.set('textMode', '1');
    await adminPage.goto(url.toString());

    await expect(adminPage.getByTestId('admin-text-mode-active')).toBeVisible({ timeout: 60_000 });

    // Loop 3 answers
    for (let i = 0; i < 3; i++) {
      const textarea = adminPage.getByTestId('admin-text-answer-textarea');
      await expect(textarea).toBeVisible({ timeout: 90_000 });
      await textarea.fill(ANSWERS[i]);
      await adminPage.getByTestId('admin-text-submit').click();

      // Wait until textarea clears (state moves to evaluating) or next question shows
      // Poll: textarea should be either re-empty (next q) or hidden (eval phase)
      await adminPage.waitForFunction(() => {
        const ta = document.querySelector(
          '[data-testid="admin-text-answer-textarea"]'
        ) as HTMLTextAreaElement | null;
        return !ta || ta.value === '';
      }, { timeout: 90_000 });
    }
  } finally {
    await ctx.request.delete(`/api/resume/${resumeId}`).catch(() => {});
  }

  // Filter known noise: SSE 4xx for terminated streams, /_next/, favicon
  const real = errors.filter(
    (e) => !/\/_next\/|favicon|\/api\/agent-interview\/.+\/(answer|skip)/.test(e)
  );
  expect(real, `unexpected errors: ${real.join(', ')}`).toEqual([]);
});
