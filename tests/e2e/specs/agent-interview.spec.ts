import { test, expect } from '../fixtures/auth';

const ANSWERS = [
  '주문 처리 시스템에서 동시성 문제를 해결하기 위해 PostgreSQL의 SELECT FOR UPDATE를 활용했습니다. 비관적 락으로 재고 차감 충돌을 방지하면서, 인덱스 설계와 쿼리 플랜 분석으로 응답 시간을 200ms 이하로 유지했습니다.',
  'FastAPI의 의존성 주입을 활용해 데이터베이스 세션과 인증 토큰 검증 로직을 재사용 가능한 형태로 분리했습니다. Pydantic 모델로 요청/응답 검증을 일원화하고 OpenAPI 스펙도 자동 생성하여 프론트엔드 팀과의 인터페이스 협업 비용을 줄였습니다.',
  '결제 실패 시 재시도 전략을 멱등키 기반으로 설계해 중복 결제를 방지했습니다. exponential backoff와 dead-letter queue를 조합해 일시적 장애와 영구 장애를 구분 처리했고, Prometheus 메트릭으로 실패율을 모니터링했습니다.',
];

test('agent-interview: textMode으로 답변 루프', async ({ adminPage, errors }) => {
  test.setTimeout(120_000);

  const ctx = adminPage.context();
  const list = await ctx.request.get('/api/resume');
  expect(list.ok(), `list failed: ${list.status()}`).toBeTruthy();
  const items = await list.json();
  expect(Array.isArray(items) && items.length > 0).toBeTruthy();
  const resumeId: string = items[0].id;

  // Direct entry: /session/new with textMode=1 — panel mounts with textMode=true,
  // skips voice setup, skips mic check dialog
  await adminPage.goto(`/agent-interview/session/new?resumeId=${resumeId}&textMode=1`);

  // textMode 활성: TextAnswerInput 컴포넌트의 textarea가 보이면 OK
  // (외부 admin 배지는 isAdmin 체크 — 부수적)
  await expect(adminPage.getByTestId('admin-text-answer-textarea')).toBeVisible({ timeout: 60_000 });

  for (let i = 0; i < ANSWERS.length; i++) {
    const textarea = adminPage.getByTestId('admin-text-answer-textarea');
    await expect(textarea).toBeVisible({ timeout: 60_000 });
    await textarea.fill(ANSWERS[i]);
    await adminPage.getByTestId('admin-text-submit').click();

    // Wait for textarea to either clear (next question) or disappear (completed)
    await adminPage.waitForFunction(() => {
      const ta = document.querySelector(
        '[data-testid="admin-text-answer-textarea"]'
      ) as HTMLTextAreaElement | null;
      return !ta || ta.value === '';
    }, { timeout: 60_000 });

    // If completed, break early
    const completed = await adminPage.getByText(/면접이 완료|리포트 확인하기/).count();
    if (completed > 0) break;
  }

  const real = errors.filter(
    (e) => !/\/_next\/|favicon|\/api\/agent-interview\/.+\/(answer|skip)/.test(e)
  );
  expect(real, `unexpected errors: ${real.join(', ')}`).toEqual([]);
});
