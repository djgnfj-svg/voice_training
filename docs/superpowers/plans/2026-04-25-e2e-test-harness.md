# E2E Test Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admin 전용 텍스트 입력 모드를 활성화하고, Playwright 기반 E2E 테스트 + 시각 회귀 + Agent 해석 스킬로 매 변경마다 자동 검증되는 회귀 테스트 환경 구축.

**Architecture:** (1) 음성 의존성을 admin textMode로 우회 → 결정적 입력. (2) Playwright spec이 NextAuth 세션 쿠키 주입으로 로그인 후 시나리오 실행. (3) `toHaveScreenshot()`으로 페이지/뷰포트 baseline 비교. (4) `voiceprep-e2e` 스킬이 결과 해석 + 화면 깨짐 휴리스틱 검증.

**Tech Stack:** Playwright (`@playwright/test`), Next.js 15, NextAuth v5, FastAPI SSE, Claude Code Skill.

---

## File Structure

**Created:**
- `tests/e2e/playwright.config.ts` — Playwright 설정 (3 viewports, dev:81 baseURL)
- `tests/e2e/fixtures/auth.ts` — admin 세션 쿠키 주입 fixture
- `tests/e2e/fixtures/session-token.ts` — Node에서 JWE 토큰 생성 헬퍼
- `tests/e2e/specs/auth.spec.ts`
- `tests/e2e/specs/resume.spec.ts`
- `tests/e2e/specs/interview-legacy.spec.ts`
- `tests/e2e/specs/agent-interview.spec.ts`
- `tests/e2e/specs/learning-coach.spec.ts`
- `tests/e2e/specs/dashboard.spec.ts`
- `tests/e2e/specs/visual.spec.ts` — 페이지별 스냅샷
- `tests/e2e/package.json` — Playwright deps 격리
- `tests/e2e/README.md` — 실행 방법
- `frontend/src/lib/admin.ts` — `isAdminEmail(email)` 공용 유틸 (서버/클라이언트)
- `frontend/src/hooks/useIsAdmin.ts` — 클라이언트 admin 체크
- `frontend/src/components/admin/text-mode-toggle.tsx` — 토글 UI
- `frontend/src/components/admin/text-answer-input.tsx` — admin 텍스트 입력 컴포넌트
- `~/.claude/skills/voiceprep-e2e/SKILL.md` — E2E 실행/해석 스킬

**Modified:**
- `frontend/src/components/agent-interview/agent-interview-panel.tsx` — admin textMode 분기
- `frontend/src/app/(authenticated)/agent-interview/session/[id]/page.tsx` — textMode prop 전달 (필요 시)
- `frontend/src/components/learning-coach/*` — 텍스트 입력 분기 (현황 확인 후)
- `frontend/src/lib/env.ts` — `NEXT_PUBLIC_ADMIN_EMAILS` 추가
- `.env.example` — `NEXT_PUBLIC_ADMIN_EMAILS` 라인
- `.gitignore` — `tests/e2e/test-results/`, `tests/e2e/playwright-report/`

---

## Task 1: Admin 판별 유틸 (frontend)

**Files:**
- Create: `frontend/src/lib/admin.ts`
- Create: `frontend/src/hooks/useIsAdmin.ts`
- Modify: `frontend/src/lib/env.ts`
- Modify: `.env.example`

- [ ] **Step 1: `.env.example`에 `NEXT_PUBLIC_ADMIN_EMAILS` 추가**

`NEXT_PUBLIC_ADMIN_EMAILS=admin@voiceprep.kr,test@voiceprep.kr` 한 줄 추가 (기존 `ADMIN_EMAILS` 바로 아래).

- [ ] **Step 2: `frontend/src/lib/admin.ts` 작성**

```ts
export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const raw = process.env.NEXT_PUBLIC_ADMIN_EMAILS ?? '';
  const list = raw.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  return list.includes(email.toLowerCase());
}
```

- [ ] **Step 3: `frontend/src/hooks/useIsAdmin.ts` 작성**

```ts
'use client';
import { useSession } from 'next-auth/react';
import { isAdminEmail } from '@/lib/admin';

export function useIsAdmin(): boolean {
  const { data } = useSession();
  return isAdminEmail(data?.user?.email);
}
```

- [ ] **Step 4: 빌드 확인**

Run: `docker compose exec frontend npm run type-check`
Expected: 에러 없음.

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/lib/admin.ts frontend/src/hooks/useIsAdmin.ts .env.example
git commit -m "feat: add admin email helper for client-side checks"
```

---

## Task 2: Admin 텍스트 입력 컴포넌트

**Files:**
- Create: `frontend/src/components/admin/text-answer-input.tsx`

- [ ] **Step 1: 컴포넌트 작성**

```tsx
'use client';
import { useState, KeyboardEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Send } from 'lucide-react';

interface Props {
  onSubmit: (text: string) => void;
  onSkip?: () => void;
  disabled?: boolean;
  placeholder?: string;
}

export function TextAnswerInput({ onSubmit, onSkip, disabled, placeholder }: Props) {
  const [value, setValue] = useState('');

  const handleSubmit = () => {
    const trimmed = value.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
    setValue('');
  };

  const handleKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="space-y-3" data-testid="admin-text-answer">
      <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-1 text-xs text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
        Admin 텍스트 모드 (음성 비활성)
      </div>
      <textarea
        data-testid="admin-text-answer-textarea"
        className="w-full min-h-[120px] rounded-md border bg-background p-3 text-sm"
        value={value}
        placeholder={placeholder ?? '답변을 입력하세요 (Ctrl/Cmd+Enter 제출)'}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKey}
        disabled={disabled}
      />
      <div className="flex justify-end gap-2">
        {onSkip && (
          <Button variant="outline" onClick={onSkip} disabled={disabled} data-testid="admin-text-skip">
            건너뛰기
          </Button>
        )}
        <Button onClick={handleSubmit} disabled={disabled || !value.trim()} data-testid="admin-text-submit">
          <Send className="mr-2 h-4 w-4" /> 제출
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 커밋**

```bash
git add frontend/src/components/admin/text-answer-input.tsx
git commit -m "feat: add admin text answer input component"
```

---

## Task 3: agent-interview-panel에 textMode 분기

**Files:**
- Modify: `frontend/src/components/agent-interview/agent-interview-panel.tsx`

- [ ] **Step 1: import + admin 훅 추가**

파일 상단 import 블록 끝에 추가:
```tsx
import { useIsAdmin } from '@/hooks/useIsAdmin';
import { TextAnswerInput } from '@/components/admin/text-answer-input';
```

- [ ] **Step 2: 컴포넌트 본문 안 `useAgentInterview` 직후에 admin + textMode 토글 state 추가**

```tsx
const isAdmin = useIsAdmin();
const [textMode, setTextMode] = useState(false);
```

- [ ] **Step 3: start 호출의 textMode를 토글값으로 변경**

`agent-interview-panel.tsx:75` 의 `start({ resumeId, jobPostingId, textMode: false })` 를 `start({ resumeId, jobPostingId, textMode })` 로 변경. 단 textMode 토글은 **start 전에만 유효**해야 하므로, useEffect 의존성은 그대로 두되 토글 UI는 "면접 시작 전" phase에서만 렌더.

- [ ] **Step 4: TTS/STT 자동 시작 useEffect들이 textMode일 때 동작하지 않도록 가드**

`useEffect(() => { if (phase !== 'waiting_answer') return; ...` 블록 (line 79–96) 시작에 `if (textMode) return;` 추가. 마찬가지로 silence 자동 제출 useEffect (line 110)에도 `if (textMode) return;` 추가. 의존성 배열에 `textMode` 포함.

- [ ] **Step 5: phase === 'waiting_answer' 렌더 분기에 textMode UI 추가**

`{/* TTS playing */}` 블록 직전(line 326)에 추가:
```tsx
{phase === 'waiting_answer' && textMode && (
  <TextAnswerInput
    onSubmit={(text) => submitAnswer(text)}
    onSkip={skip}
    disabled={false}
  />
)}
```
그리고 기존 `{phase === 'waiting_answer' && tts.isSpeaking ...}`, `{phase === 'waiting_answer' && speech.isListening ...}`, `{phase === 'waiting_answer' && !tts.isSpeaking && !speech.isListening ...}` 세 블록 모두 조건에 `&& !textMode` 추가.

- [ ] **Step 6: Header 영역에 admin 토글 노출**

`{/* Progress + Volume */}` 직전 (line 232 즈음)에 추가:
```tsx
{isAdmin && phase === 'loading_profile' && questionCount === 0 && (
  <div className="flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm dark:border-amber-800 dark:bg-amber-950/40" data-testid="admin-text-mode-toggle">
    <input
      id="admin-text-mode"
      type="checkbox"
      checked={textMode}
      onChange={(e) => setTextMode(e.target.checked)}
    />
    <label htmlFor="admin-text-mode" className="cursor-pointer">Admin: 텍스트 입력 모드</label>
  </div>
)}
```
**주의**: useEffect의 자동 start 때문에 토글이 의미 있으려면 mount 직후 첫 frame에 토글 가능해야 함. 따라서 토글 자체는 항상 렌더(phase 무관) + `startedRef.current` 검사로 시작 후 변경 못 하도록만 안내. 이걸 단순화해서: 토글은 admin이면 항상 표시하되, `disabled={questionCount > 0 || phase !== 'idle' && phase !== 'loading_profile'}` 처럼 비활성. 실제로는 `start`가 mount 후 즉시 호출되므로 textMode 초기값을 URL query `?textMode=1`로도 받게 한다.

대신 **단순화**: query param `?textMode=1`로 시작값 결정.
```tsx
const [textMode, setTextMode] = useState(() => {
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).get('textMode') === '1';
});
```
이러면 E2E 테스트에서 `/agent-interview/session/<id>?textMode=1`로 접근만 하면 됨. UI 토글은 admin 시 visible read-only 표시:
```tsx
{isAdmin && textMode && (
  <div data-testid="admin-text-mode-active" className="rounded-md border border-amber-300 bg-amber-50 px-3 py-1 text-xs text-amber-700">
    Admin 텍스트 모드 활성 (URL ?textMode=1)
  </div>
)}
```
checkbox UI는 제거. step 6는 이 단순한 표시만 추가.

- [ ] **Step 7: 타입 체크**

Run: `docker compose exec frontend npm run type-check`
Expected: 통과.

- [ ] **Step 8: dev 리빌드 + 수동 확인**

```bash
docker compose build frontend && docker compose up -d frontend nginx
```
브라우저 `http://localhost:81/agent-interview/session/<id>?textMode=1` 접근 → textarea 보임 확인.

- [ ] **Step 9: 커밋**

```bash
git add frontend/src/components/agent-interview/agent-interview-panel.tsx
git commit -m "feat: admin text-mode for agent interview via ?textMode=1"
```

---

## Task 4: agent-interview 시작 페이지에서도 query 전달

**Files:**
- Modify: `frontend/src/app/(authenticated)/agent-interview/session/[id]/page.tsx` (있다면)
- Modify: agent-interview 셋업 시작 버튼 (resumeId/jobPostingId만 넘기고 redirect)

- [ ] **Step 1: 셋업 → 세션 시작 redirect 코드 위치 확인**

Run: `grep -rn "agent-interview/session" frontend/src/`
세션 페이지로 이동하는 코드 라인 번호 기록.

- [ ] **Step 2: admin인 경우 redirect URL에 `?textMode=1` 자동 부착**

해당 코드에 `useIsAdmin()` 훅 호출 + URL 조립 시 `${baseUrl}${isAdmin ? '?textMode=1' : ''}`.
**대안 (더 안전)**: 자동 부착 안 하고 E2E 테스트에서 명시적으로 URL에 붙임. 자동 부착은 일반 admin 사용자의 음성 면접을 막을 수 있으니 **자동 부착 안 함**.

- [ ] **Step 3: Step 2를 "안 함"으로 결정. 따라서 Task 4는 noop.**

스킵하고 Task 5로 진행.

---

## Task 5: learning-coach textMode 분기

**Files:**
- Read: `frontend/src/app/(authenticated)/learning-coach/session/page.tsx` (구조 확인)
- Modify: learning-coach 세션 컴포넌트 (TBD — Task 5 step 1에서 위치 확정)

- [ ] **Step 1: learning-coach 세션 UI 파일 식별**

Run: `ls frontend/src/components/learning-coach/ && ls frontend/src/app/\(authenticated\)/learning-coach/session/`
음성 입력 처리하는 메인 컴포넌트 파일 경로 기록 (`learning-coach-panel.tsx` 같은 이름 추정).

- [ ] **Step 2: 해당 컴포넌트에 agent-interview-panel과 동일 패턴 적용**

useIsAdmin + URL `?textMode=1` 감지 + waiting_answer phase에서 음성 UI 대신 `<TextAnswerInput onSubmit={respond} />` 렌더. 기존 음성 useEffect는 `if (textMode) return;` 가드.

learning-coach API 함수에는 textMode 파라미터 없음 (backend는 기록 안 함) — 클라이언트만 분기.

- [ ] **Step 3: 타입 체크 + 수동 확인**

Run: `docker compose exec frontend npm run type-check`
브라우저: `http://localhost:81/learning-coach/session/<id>?textMode=1`

- [ ] **Step 4: 커밋**

```bash
git add frontend/src/components/learning-coach/ frontend/src/app/\(authenticated\)/learning-coach/
git commit -m "feat: admin text-mode for learning coach via ?textMode=1"
```

---

## Task 6: Playwright 셋업

**Files:**
- Create: `tests/e2e/package.json`
- Create: `tests/e2e/playwright.config.ts`
- Create: `tests/e2e/.gitignore`
- Modify: `.gitignore` (root)

- [ ] **Step 1: `tests/e2e/package.json`**

```json
{
  "name": "voiceprep-e2e",
  "private": true,
  "scripts": {
    "test": "playwright test",
    "test:visual": "playwright test specs/visual.spec.ts",
    "test:headed": "playwright test --headed",
    "report": "playwright show-report"
  },
  "devDependencies": {
    "@playwright/test": "^1.48.0",
    "next-auth": "5.0.0-beta.30",
    "@auth/core": "^0.37.0"
  }
}
```

- [ ] **Step 2: `tests/e2e/playwright.config.ts`**

```ts
import { defineConfig, devices } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:81';

export default defineConfig({
  testDir: './specs',
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: BASE,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  expect: {
    toHaveScreenshot: { maxDiffPixelRatio: 0.02 },
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'tablet', use: { ...devices['Desktop Chrome'], viewport: { width: 768, height: 1024 } } },
    { name: 'mobile', use: { ...devices['iPhone 13'] } },
  ],
});
```

- [ ] **Step 3: `tests/e2e/.gitignore`**

```
node_modules
test-results
playwright-report
.playwright
```

- [ ] **Step 4: 루트 `.gitignore`에 추가**

```
tests/e2e/test-results/
tests/e2e/playwright-report/
tests/e2e/node_modules/
```

- [ ] **Step 5: deps 설치 + 브라우저**

```bash
cd tests/e2e && npm install && npx playwright install chromium
```

- [ ] **Step 6: 커밋**

```bash
git add tests/e2e/package.json tests/e2e/playwright.config.ts tests/e2e/.gitignore .gitignore tests/e2e/package-lock.json
git commit -m "chore: scaffold playwright e2e harness"
```

---

## Task 7: NextAuth 세션 쿠키 주입 fixture

**Files:**
- Create: `tests/e2e/fixtures/session-token.ts`
- Create: `tests/e2e/fixtures/auth.ts`

배경: NextAuth v5 JWE 세션을 직접 구워서 쿠키로 주입. 백엔드는 `joserfc` + HKDF로 복호화하므로 동일 알고리즘 사용. NextAuth가 사용하는 JWT는 `@auth/core/jwt` 모듈의 `encode` 함수.

- [ ] **Step 1: `tests/e2e/fixtures/session-token.ts`**

```ts
import { encode } from '@auth/core/jwt';

export interface AdminUserSeed {
  id: string;
  email: string;
  name: string;
}

export async function bakeSessionCookie(user: AdminUserSeed): Promise<string> {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) throw new Error('NEXTAUTH_SECRET env required for E2E');
  const token = await encode({
    token: { sub: user.id, email: user.email, name: user.name },
    secret,
    salt: '__Secure-authjs.session-token',
  });
  return token;
}
```

- [ ] **Step 2: `tests/e2e/fixtures/auth.ts`**

```ts
import { test as base, expect, Page } from '@playwright/test';
import { bakeSessionCookie } from './session-token';

const ADMIN = {
  id: process.env.E2E_ADMIN_USER_ID ?? '',
  email: process.env.E2E_ADMIN_EMAIL ?? 'test@voiceprep.kr',
  name: 'E2E Admin',
};

export const test = base.extend<{ adminPage: Page }>({
  adminPage: async ({ browser, baseURL }, use) => {
    if (!ADMIN.id) throw new Error('E2E_ADMIN_USER_ID env required');
    const token = await bakeSessionCookie(ADMIN);
    const ctx = await browser.newContext({ baseURL });
    await ctx.addCookies([
      {
        name: '__Secure-authjs.session-token',
        value: token,
        domain: new URL(baseURL!).hostname,
        path: '/',
        httpOnly: true,
        secure: false,
        sameSite: 'Lax',
      },
    ]);
    const page = await ctx.newPage();
    await use(page);
    await ctx.close();
  },
});

export { expect };
```

- [ ] **Step 3: dev 환경에서 cookie name 확인**

dev는 http라 NextAuth가 `authjs.session-token` (Secure prefix 없음) 사용 가능성. `__Secure-`는 https 전용. dev가 http://localhost:81이면 prefix 빼야 함.

`tests/e2e/fixtures/auth.ts`의 cookie name을 환경에 따라:
```ts
const baseUrlObj = new URL(baseURL!);
const cookieName = baseUrlObj.protocol === 'https:'
  ? '__Secure-authjs.session-token'
  : 'authjs.session-token';
```
salt도 동일하게 분기 (encode salt와 cookie name은 일치해야 함).

`session-token.ts`도 salt 파라미터로 받게 변경:
```ts
export async function bakeSessionCookie(user: AdminUserSeed, salt: string): Promise<string> { ... }
```
`auth.ts`에서 `bakeSessionCookie(ADMIN, cookieName)` 호출.

- [ ] **Step 4: README 작성**

`tests/e2e/README.md`:
```md
# VoicePrep E2E

## 환경 변수
다음을 셸 또는 `tests/e2e/.env`에 설정:
- NEXTAUTH_SECRET — 루트 .env와 동일
- E2E_ADMIN_USER_ID — admin 계정의 User.id (Prisma)
- E2E_ADMIN_EMAIL — NEXT_PUBLIC_ADMIN_EMAILS에 포함된 이메일
- E2E_BASE_URL (기본 http://localhost:81)

## 실행
cd tests/e2e
npm test                  # 전체
npm run test:visual       # 시각 회귀만
npx playwright test specs/agent-interview.spec.ts

## Baseline 갱신
npx playwright test --update-snapshots
```

- [ ] **Step 5: smoke 테스트로 fixture 검증**

`tests/e2e/specs/auth.spec.ts`:
```ts
import { test, expect } from '../fixtures/auth';

test('admin session loads dashboard', async ({ adminPage }) => {
  await adminPage.goto('/dashboard');
  await expect(adminPage.getByRole('heading', { name: /대시보드/ })).toBeVisible();
});
```

Run: `cd tests/e2e && npx playwright test specs/auth.spec.ts --project=desktop`
Expected: 1 passed.
실패 시 cookie name/salt/secret 점검.

- [ ] **Step 6: 커밋**

```bash
git add tests/e2e/fixtures tests/e2e/specs/auth.spec.ts tests/e2e/README.md
git commit -m "feat: nextauth session cookie injection for e2e"
```

---

## Task 8: Resume spec

**Files:**
- Create: `tests/e2e/specs/resume.spec.ts`
- Create: `tests/e2e/fixtures/sample-resume.json` (Resume.parsedData 형태)

- [ ] **Step 1: 샘플 이력서 fixture**

`tests/e2e/fixtures/sample-resume.json`:
```json
{
  "summary": "백엔드 5년차. Python/FastAPI/PostgreSQL.",
  "projects": [
    {"name": "Order System", "techStack": ["Python", "FastAPI", "PostgreSQL"], "description": "주문 처리 시스템 설계 및 구현"}
  ],
  "experience": [
    {"company": "Acme", "role": "Backend Engineer", "period": "2021–2026"}
  ],
  "education": []
}
```

- [ ] **Step 2: `tests/e2e/specs/resume.spec.ts`**

```ts
import { test, expect } from '../fixtures/auth';
import sample from '../fixtures/sample-resume.json';

test('이력서 생성 → 목록 노출 → 삭제', async ({ adminPage, request }) => {
  // 백엔드 API로 직접 생성 (UI 파싱 우회)
  const create = await request.post('/api/resume', {
    data: { name: 'E2E Resume', parsedData: sample },
  });
  expect(create.ok()).toBeTruthy();
  const { id } = await create.json();

  await adminPage.goto('/interview/setup?tab=resume');
  await expect(adminPage.getByText('E2E Resume')).toBeVisible();

  // 삭제
  const del = await request.delete(`/api/resume/${id}`);
  expect(del.ok()).toBeTruthy();
});
```

**주의**: `request` fixture는 cookie 자동 공유 안 됨 → `adminPage.context().request` 사용 필요. 수정:
```ts
test('...', async ({ adminPage }) => {
  const ctx = adminPage.context();
  const create = await ctx.request.post('/api/resume', { data: ... });
  ...
});
```

- [ ] **Step 3: 실행 + 디버그**

Run: `cd tests/e2e && npx playwright test specs/resume.spec.ts --project=desktop`
실패하면 백엔드 응답 trace 확인.

- [ ] **Step 4: 커밋**

```bash
git add tests/e2e/specs/resume.spec.ts tests/e2e/fixtures/sample-resume.json
git commit -m "test(e2e): resume create/list/delete"
```

---

## Task 9: Legacy interview spec (textMode)

**Files:**
- Create: `tests/e2e/specs/interview-legacy.spec.ts`

- [ ] **Step 1: spec 작성**

```ts
import { test, expect } from '../fixtures/auth';
import sample from '../fixtures/sample-resume.json';

test('legacy interview: textMode 답변 → 리포트', async ({ adminPage }) => {
  const ctx = adminPage.context();
  const r = await ctx.request.post('/api/resume', { data: { name: 'E2E', parsedData: sample } });
  const resume = await r.json();

  await adminPage.goto('/interview/setup');
  await adminPage.getByText('E2E').click();
  // textMode 토글 (legacy UI에 이미 존재 — selector 확인 필요)
  await adminPage.getByLabel(/텍스트 모드/).check();
  await adminPage.getByRole('button', { name: /면접 시작/ }).click();

  // 마이크 체크 다이얼로그가 textMode면 스킵되어야 함 (확인 필요)
  // 질문 표시 대기
  await expect(adminPage.getByTestId(/question/i).first()).toBeVisible({ timeout: 30_000 });

  // 첫 질문 답변
  await adminPage.getByRole('textbox').first().fill('FastAPI는 Python 기반 비동기 웹 프레임워크입니다. Pydantic 기반 검증과 OpenAPI 자동 생성이 특징입니다.');
  await adminPage.getByRole('button', { name: /제출|답변/ }).click();

  // 리포트 도달
  await expect(adminPage.getByText(/리포트|점수/)).toBeVisible({ timeout: 60_000 });

  await ctx.request.delete(`/api/resume/${resume.id}`);
});
```

**주의**: legacy UI의 textMode 토글/textarea selector는 실제 코드 확인 필요. step 2에서 보정.

- [ ] **Step 2: legacy textMode UI selector 확정**

Run: `grep -rn "textMode" frontend/src/components/interview/ frontend/src/app/\(authenticated\)/interview/ | head -20`
실제 토글 라벨/textarea data-testid 확인 → spec 수정.

- [ ] **Step 3: 실행**

Run: `cd tests/e2e && npx playwright test specs/interview-legacy.spec.ts --project=desktop`
실패 시 trace 보고 selector 수정.

- [ ] **Step 4: 커밋**

```bash
git add tests/e2e/specs/interview-legacy.spec.ts
git commit -m "test(e2e): legacy interview text-mode flow"
```

---

## Task 10: Agent interview spec (SSE phase 검증)

**Files:**
- Create: `tests/e2e/specs/agent-interview.spec.ts`

- [ ] **Step 1: spec 작성**

```ts
import { test, expect } from '../fixtures/auth';
import sample from '../fixtures/sample-resume.json';

test('agent-interview: textMode로 scan→dive 완주', async ({ adminPage }) => {
  const ctx = adminPage.context();
  const r = await ctx.request.post('/api/resume', { data: { name: 'E2E Agent', parsedData: sample } });
  const resume = await r.json();

  // 셋업 → AI 코치 모드 선택 → 시작 (URL에 ?textMode=1 부착)
  await adminPage.goto('/interview/setup');
  await adminPage.getByText('E2E Agent').click();
  await adminPage.getByText(/AI 코치/).click();
  await adminPage.getByRole('button', { name: /면접 시작/ }).click();

  // 마이크 체크 다이얼로그 → 확인
  await adminPage.getByRole('button', { name: /확인|시작/ }).click();

  // 세션 페이지 도달했는지 확인 후 textMode URL로 재진입
  await adminPage.waitForURL(/\/agent-interview\/session\//);
  const url = new URL(adminPage.url());
  url.searchParams.set('textMode', '1');
  await adminPage.goto(url.toString());

  await expect(adminPage.getByTestId('admin-text-mode-active')).toBeVisible({ timeout: 30_000 });

  // 질문 도착 → 답변 3회 (scan 단계)
  for (let i = 0; i < 3; i++) {
    await expect(adminPage.getByTestId('admin-text-answer-textarea')).toBeVisible({ timeout: 60_000 });
    await adminPage.getByTestId('admin-text-answer-textarea').fill(
      `질문 ${i + 1} 답변: 이 프로젝트에서 PostgreSQL의 트랜잭션 격리수준을 활용해 동시성 문제를 해결했습니다. 인덱스 설계와 쿼리 플랜 분석으로 응답 시간을 200ms 이하로 유지했습니다.`
    );
    await adminPage.getByTestId('admin-text-submit').click();
  }

  // 콘솔 에러 0건 확인
  // (test 시작 시 page.on('console') 등록 필요 — fixture에 추가하는 게 더 깔끔)
});
```

- [ ] **Step 2: 콘솔/네트워크 에러 수집을 fixture에 추가**

`tests/e2e/fixtures/auth.ts`의 `adminPage` 안에 `page.on('console', ...)` + `page.on('response', ...)` 추가하여 errors 배열 수집. test 끝에 `expect(errors).toEqual([])` 가능하게 export.

```ts
export const test = base.extend<{ adminPage: Page; errors: string[] }>({
  errors: async ({}, use) => { await use([]); },
  adminPage: async ({ browser, baseURL, errors }, use) => {
    // ... 기존 ...
    page.on('console', (msg) => { if (msg.type() === 'error') errors.push(`[console] ${msg.text()}`); });
    page.on('response', (res) => {
      if (res.status() >= 400 && !res.url().includes('favicon')) errors.push(`[http ${res.status()}] ${res.url()}`);
    });
    await use(page);
    // ...
  },
});
```

각 spec에서 `test('...', async ({ adminPage, errors }) => { ... expect(errors).toEqual([]); })`

- [ ] **Step 3: 실행 + 디버그**

Run: `cd tests/e2e && npx playwright test specs/agent-interview.spec.ts --project=desktop`
실제 LLM 호출이 들어가서 1~2분 소요 가능 → playwright config의 timeout 늘리기:
`tests/e2e/playwright.config.ts`에 `timeout: 180_000` 추가.

- [ ] **Step 4: 커밋**

```bash
git add tests/e2e/specs/agent-interview.spec.ts tests/e2e/fixtures/auth.ts tests/e2e/playwright.config.ts
git commit -m "test(e2e): agent-interview text-mode flow with console/http guards"
```

---

## Task 11: Learning-coach spec

**Files:**
- Create: `tests/e2e/specs/learning-coach.spec.ts`

- [ ] **Step 1: spec 작성 (mobile viewport 필수)**

```ts
import { test, expect } from '../fixtures/auth';

test('learning-coach: 시작 → 텍스트 응답 → 종료', async ({ adminPage, errors }) => {
  await adminPage.goto('/learning-coach');
  await adminPage.getByRole('button', { name: /시작|학습/ }).click();

  await adminPage.waitForURL(/\/learning-coach\/session\//);
  const url = new URL(adminPage.url());
  url.searchParams.set('textMode', '1');
  await adminPage.goto(url.toString());

  for (let i = 0; i < 2; i++) {
    await expect(adminPage.getByTestId('admin-text-answer-textarea')).toBeVisible({ timeout: 60_000 });
    await adminPage.getByTestId('admin-text-answer-textarea').fill(
      `학습 응답 ${i + 1}: 트리 자료구조에서 BFS는 큐를 사용하고 DFS는 스택 또는 재귀를 사용합니다.`
    );
    await adminPage.getByTestId('admin-text-submit').click();
  }

  await adminPage.getByRole('button', { name: /종료|마치기/ }).click();
  await expect(adminPage.getByText(/요약|완료/)).toBeVisible({ timeout: 60_000 });

  expect(errors).toEqual([]);
});
```

- [ ] **Step 2: 실행**

```bash
cd tests/e2e && npx playwright test specs/learning-coach.spec.ts --project=mobile
```

- [ ] **Step 3: 커밋**

```bash
git add tests/e2e/specs/learning-coach.spec.ts
git commit -m "test(e2e): learning-coach text-mode flow"
```

---

## Task 12: Dashboard / history spec

**Files:**
- Create: `tests/e2e/specs/dashboard.spec.ts`

- [ ] **Step 1: spec 작성**

```ts
import { test, expect } from '../fixtures/auth';

test('dashboard 로드 + 차트 노출 + 콘솔 무에러', async ({ adminPage, errors }) => {
  await adminPage.goto('/dashboard');
  await expect(adminPage.getByRole('heading', { name: /대시보드/ })).toBeVisible();
  // recharts SVG 노출
  await expect(adminPage.locator('svg.recharts-surface').first()).toBeVisible({ timeout: 15_000 });
  expect(errors).toEqual([]);
});

test('history 통합 노출 (legacy + agent)', async ({ adminPage }) => {
  await adminPage.goto('/interview/setup');
  // 면접 기록 섹션 존재
  await expect(adminPage.getByText(/면접 기록|기록이 없/)).toBeVisible();
});
```

- [ ] **Step 2: 실행 + 커밋**

```bash
cd tests/e2e && npx playwright test specs/dashboard.spec.ts --project=desktop
git add tests/e2e/specs/dashboard.spec.ts
git commit -m "test(e2e): dashboard and history smoke"
```

---

## Task 13: 시각 회귀 spec (3 viewport baseline)

**Files:**
- Create: `tests/e2e/specs/visual.spec.ts`

- [ ] **Step 1: spec 작성**

```ts
import { test, expect } from '../fixtures/auth';

const PAGES = [
  { path: '/dashboard', name: 'dashboard' },
  { path: '/interview/setup', name: 'interview-setup' },
  { path: '/interview/setup?tab=resume', name: 'resume-tab' },
  { path: '/learning-coach', name: 'learning-coach' },
];

for (const p of PAGES) {
  test(`visual: ${p.name}`, async ({ adminPage }, info) => {
    await adminPage.goto(p.path);
    await adminPage.waitForLoadState('networkidle');
    // recharts/이미지가 layout shift 일으키므로 한 번 더 대기
    await adminPage.waitForTimeout(500);
    await expect(adminPage).toHaveScreenshot(`${p.name}-${info.project.name}.png`, {
      fullPage: true,
      animations: 'disabled',
      mask: [adminPage.locator('[data-dynamic]')],
    });
  });
}
```

- [ ] **Step 2: baseline 생성**

```bash
cd tests/e2e && npx playwright test specs/visual.spec.ts --update-snapshots
```

생성된 PNG 파일들이 `tests/e2e/specs/visual.spec.ts-snapshots/` 에 위치. 검토 후 커밋.

- [ ] **Step 3: 다시 실행 (회귀 모드)**

```bash
npx playwright test specs/visual.spec.ts
```
Expected: 모두 PASS (방금 만든 baseline과 동일).

- [ ] **Step 4: 커밋**

```bash
git add tests/e2e/specs/visual.spec.ts tests/e2e/specs/visual.spec.ts-snapshots/
git commit -m "test(e2e): visual regression baselines for key pages"
```

---

## Task 14: voiceprep-e2e 스킬

**Files:**
- Create: `~/.claude/skills/voiceprep-e2e/SKILL.md`

- [ ] **Step 1: SKILL.md 작성**

````md
---
name: voiceprep-e2e
description: VoicePrep E2E 테스트 실행 + 결과 해석 + 화면 깨짐 휴리스틱 검증. "/e2e", "E2E 돌려", "회귀 테스트", "스크린샷 비교", "프론트 깨졌나" 요청 시 사용.
---

# VoicePrep E2E 스킬

## 사용 시점
- 사용자가 "E2E 돌려줘", "회귀 확인", "프론트 깨진 데 있나" 등 회귀 검증 요청
- 큰 프론트/백엔드 변경 후 자동 검증
- `/e2e <시나리오>` 형태 호출

## 실행 절차

### 1. dev 환경 확인
```bash
docker compose ps
```
3개 컨테이너 (frontend/backend/nginx) Up 확인. 아니면 `docker compose up -d`.

### 2. 환경 변수 확인
`tests/e2e/.env` 또는 셸에 `NEXTAUTH_SECRET`, `E2E_ADMIN_USER_ID`, `E2E_ADMIN_EMAIL` 설정 확인. 없으면 사용자에게 묻기.

### 3. 시나리오별 실행
- 전체: `cd tests/e2e && npm test`
- 시각 회귀만: `npm run test:visual`
- 특정: `npx playwright test specs/<name>.spec.ts`

### 4. 결과 해석
실패 시 항상 다음 순서로 진단:
1. `tests/e2e/playwright-report/index.html` (또는 `npm run report`)
2. trace 파일 (`tests/e2e/test-results/.../trace.zip`)
3. 시각 회귀 실패 → diff PNG 검토 (`*-actual.png` vs `*-expected.png` vs `*-diff.png`). 의도된 변경이면 `--update-snapshots`로 갱신, 아니면 회귀 보고.
4. 콘솔/HTTP 에러 → backend 로그 (`docker compose logs --tail=200 backend`) 대조.

### 5. 화면 깨짐 휴리스틱
시각 diff 외에 추가 검사:
- 페이지가 빈 상태(`<body>` 자식 없음)인지
- "Application error", "500", "Hydration failed" 텍스트
- 핵심 리소스 4xx/5xx
- layout overflow (`document.body.scrollWidth > viewport.width`)

이런 건 visual.spec에 추가하거나 별도 ad-hoc 체크 스크립트로.

## 주의
- 실호출 LLM이 비결정적 → SSE 흐름은 검증하되 텍스트 내용은 검증 안 함
- `node.exe` 죽이지 말 것 — dev 서버 죽음
- baseline 갱신은 사용자 명시 승인 후에만
````

- [ ] **Step 2: 스킬 등록 확인**

Claude Code 재시작 또는 `/refresh` 후 `/e2e` 가능한지 사용자에게 확인 요청.

- [ ] **Step 3: 커밋**

스킬은 사용자 홈 (`~/.claude/skills/`)이라 repo와 무관 → 커밋 없음. 대신 `tests/e2e/README.md`에 "스킬 위치" 추가.

---

## Task 15: 최종 통합 실행

- [ ] **Step 1: 전체 spec 실행**

```bash
cd tests/e2e && npm test
```

- [ ] **Step 2: 결과 확인**

`npm run report`로 HTML 리포트. 실패한 spec 있으면 각각 디버그 후 재실행.

- [ ] **Step 3: 최종 커밋 (수정사항 있다면)**

```bash
git add -A
git commit -m "test(e2e): full suite green"
```

---

## 자기 검토 체크리스트

- [x] textMode 토글 (admin) — Task 3 (agent), Task 5 (coach), Task 9 (legacy 활용)
- [x] Playwright 셋업 — Task 6
- [x] 세션 쿠키 인증 — Task 7
- [x] 도메인 spec — Task 8~12
- [x] 시각 회귀 — Task 13
- [x] Agent 해석 스킬 — Task 14
- [x] 콘솔/HTTP 에러 가드 — Task 10 step 2 (fixture)

## 알려진 한계
- Google OAuth 실로그인은 검증 안 함 (cookie 주입으로 우회) — OAuth 자체 회귀는 수동
- LLM 응답 *내용* 품질은 별도 eval harness (`tests/eval/`)가 담당
- 음성 (Web Speech, Whisper, TTS) 자체는 textMode 우회로 결정성 확보 — 음성 회귀는 별도 수동
