# 모범답안 학습 모드 품질 개선 (Spec)

- **작성일**: 2026-04-14
- **대상 영역**: 모범답안 학습 (`/interview/model-answer`)
- **목표**: 단일 LLM 호출 batch 생성 구조에서 **질문 batch + 모범답안 개별 호출(병렬) + 이력서 RAG 주입** 구조로 전환해 모범답안 깊이/디테일 품질을 끌어올린다.

## 1. 배경 / 문제 정의

현재 모범답안 생성은 단일 프롬프트 1회 호출로 질문 5개와 각 모범답안 + keyPoints + answerTips를 JSON으로 한 번에 생성한다 (`backend/app/routers/model_answer.py:96-99`).

문제점:

1. **모범답안 품질 희석** — 같은 토큰 예산(`max_tokens=8192`)에 질문+답변+팁 15개 필드를 전부 욱여넣다 보니 개별 모범답안의 길이·디테일이 얕아짐. 실제 면접에서 "말하는 구어체 5~8문장"을 지시하지만 평균 3~4문장에 일반론 위주.
2. **이력서 통째 주입** — `json.dumps(resume.parsed_data)`로 전체 이력서를 프롬프트에 투하 (`model_answer.py:71`). 시니어급 이력서(프로젝트 10개+)에선 5000+ 토큰 차지하고 중요 섹션이 묻힘.
3. **이력서 RAG 미활용** — 에이전트 면접에는 이미 `backend/app/agent/resume_rag.py` (summary/project/experience/education 청킹 + pgvector 검색)이 구축되어 있는데 모범답안 모드는 이를 전혀 사용하지 않음.
4. **프로필 RAG 결합 없음** — 본 스펙 범위 밖 (의도적. 모범답안은 정적 학습 자료).

## 2. 비목표 (YAGNI)

- 에이전트 상태 머신 도입 (모범답안은 정적 학습 자료 — AI 코치 면접과 포지션 겹침 방지)
- 프로필 RAG (`user_profile_embeddings`) 연동 — 강점/약점 반영은 에이전트 면접의 역할
- 꼬리질문 / 평가 / 스트리밍 — 모드 정체성상 불필요
- Fit Analysis (JD×이력서 매칭) — 현재 프롬프트에서 `jobPostingText`를 LLM에 implicit하게 맡기는 방식 유지
- 모범답안 재생성 / 편집 기능
- 모델 교체 (`AGENT_MODEL` 운영자 조정 영역. 스펙에선 기본 모델 유지)

## 3. 핵심 의사결정

| # | 결정 사항 | 결정 내용 | 대안 대비 채택 이유 |
|---|---|---|---|
| D1 | **생성 구조** | 2-step: ①질문 batch (1회) + ②모범답안 개별 (N회 병렬) | 단일 batch 유지(토큰 희석 해결 안 됨)·완전 개별화(질문 카테고리 균형 LLM이 보장 못함) 대비 품질↑·균형 유지 |
| D2 | **질문 단계 출력** | text / source / category / difficulty **4필드만** 생성. modelAnswer·keyPoints·answerTips 제거 | 질문+답변 동시 생성(현행. 희석)·최소필드(text만. 카테고리 균형 감시 불가) 대비 기획 의도 유지 + 토큰 절감 |
| D3 | **모범답안 단계 입력** | 질문 1개 + 이력서 청크 top-3 (RAG) + 채용공고(있으면) + 메타(interviewType/difficulty) | JSON 전체 주입(희석)·요약만 주입(디테일 손실) 대비 질문 관련 청크만 집중해서 깊이 있는 답변 유도 |
| D4 | **RAG fallback** | `has_resume_embeddings(resume_id) == False`이면 `parsedResume JSON` 주입 (현 동급 fallback) | lazy 임베딩(첫 모범답안 5~10초 지연)·에러 반환(UX 손실) 대비 안전망 유지 |
| D5 | **병렬 전략** | `asyncio.gather(*[generate_answer(q) for q in questions])` — 질문 개수만큼 동시 호출 | 순차(지연 5배)·부분 배치(복잡도) 대비 단순 + 지연 거의 동일 |
| D6 | **에러 처리** | 질문 생성 실패 → 500 + 미차감. 모범답안 1개 실패 → 해당 질문 제외 후 계속 (gather `return_exceptions=True`). 전부 실패 → 500 + 미차감 | 부분 실패 전파(사용자 경험 악화)·재시도 큐(YAGNI) 대비 실사용성↑ |
| D7 | **크레딧 차감 타이밍** | 모범답안 생성 완료(최소 1개 이상) 직후 차감 (현행 동일) | 질문 batch 후 차감(모범답안 다 실패 시 환불 필요)·선차감(CLAUDE.md 위반) 대비 안전 |

## 4. 아키텍처

### 4.1 변경 파일

```
backend/app/prompts/model_answer.py          ← 리팩토링
  제거: MODEL_ANSWER_RESUME_PROMPT, MODEL_ANSWER_WITH_JOB_PROMPT (통합 프롬프트)
  추가: QUESTION_GEN_RESUME_PROMPT, QUESTION_GEN_WITH_JOB_PROMPT (질문만)
        MODEL_ANSWER_PROMPT (질문 1개 → 모범답안 + keyPoints + answerTips)

backend/app/routers/model_answer.py          ← 리팩토링
  generate_model_answer():
    1. Resume 소유권 검증 (현행 유지)
    2. Credit check (현행 유지)
    3. plan_interview (현행 유지)
    4. 질문 batch 생성 (QUESTION_GEN_* 프롬프트, call_llm_json 1회)
    5. has_resume_embeddings 체크 → RAG 모드 / JSON fallback 모드 분기
    6. asyncio.gather로 질문별 모범답안 생성 (return_exceptions=True)
    7. 최소 1개 성공 확인 → 크레딧 차감 → ActivityLog 저장
```

### 4.2 플로우 다이어그램

```
[요청] resumeId, jobPostingText?
   │
   ├─> Resume 소유권 검증
   ├─> can_start_session (크레딧 체크)
   ├─> plan_interview → {type, categories, difficulty, totalQuestions}
   │
   ├─> LLM #1: 질문 batch 생성 (QUESTION_GEN_*_PROMPT)
   │      out: [{text, source, category, difficulty}] × N
   │
   ├─> has_resume_embeddings?
   │      ├─ Yes: 질문마다 search_resume(query=question.text, top_k=3)
   │      └─ No:  parsed_resume JSON 한 번 직렬화 → 전 질문 공통
   │
   ├─> LLM #2~N+1: asyncio.gather — 질문별 모범답안 생성 (MODEL_ANSWER_PROMPT)
   │      in:  {question, resumeContext(청크 or JSON), jobPostingText, meta}
   │      out: {modelAnswer, keyPoints, answerTips}
   │
   ├─> 성공한 항목만 merge (실패는 warn 로그 + 제외)
   │     if len(merged) == 0: raise 500
   │
   ├─> 크레딧 차감 (무료체험/결제 분기, 현행 로직 유지)
   ├─> ActivityLog + ActivityItem 저장 (현행 스키마 유지: answer=modelAnswer, extra={keyPoints, answerTips})
   └─> return {plan, questions, activityLogId}
```

### 4.3 토큰·지연 예상

| 항목 | Before | After |
|---|---|---|
| LLM 호출 수 | 1 | 1 + N (N=5, 총 6) |
| 프롬프트 토큰(총합) | ~8k | 질문 batch ~3k + 답변 5개 × (청크 1k) = ~8k |
| 응답 토큰(총합) | ~4k | ~6k (답변당 1~1.2k로 늘어남) |
| 지연 시간 | ~10s | ~15s (병렬 이후 답변 단계 최장 답변 시간) |
| 비용 (gpt-4o-mini 기준) | ~$0.004 | ~$0.008 |

**결론**: 비용 2배·지연 1.5배 증가하지만 모범답안 디테일 뚜렷하게 개선 예상.

## 5. 프롬프트 상세

### 5.1 `QUESTION_GEN_RESUME_PROMPT`

이력서 기반 질문 N개 생성. **질문만** 뽑고 modelAnswer/keyPoints/answerTips는 다음 단계로 미룸.

출력 스키마:
```json
{
  "questions": [
    {
      "text": "질문 텍스트",
      "source": "resume_based",
      "category": "프로젝트 심층 | 기술 역량 | 성장/경험",
      "difficulty": "BEGINNER | INTERMEDIATE | ADVANCED"
    }
  ]
}
```

### 5.2 `QUESTION_GEN_WITH_JOB_PROMPT`

이력서 + 채용공고 기반 질문 N개. `source` enum에 `job_posting` 추가.

### 5.3 `MODEL_ANSWER_PROMPT`

단일 질문 1개 → 모범답안 + keyPoints + answerTips.

입력 변수:
- `question`: 질문 텍스트
- `category`, `difficulty`: 질문 메타
- `resumeContext`: 이력서 청크(RAG 모드) 또는 전체 JSON(fallback 모드)
- `jobPostingText`: 채용공고 (없으면 빈 문자열)

출력 스키마:
```json
{
  "modelAnswer": "1인칭 구어체 5~8문장",
  "keyPoints": ["핵심 1", "핵심 2"],
  "answerTips": ["이 답변이 좋은 이유 1", "이유 2"]
}
```

프롬프트 요지 (규칙 강화):
- **STAR 구조 명시 (S/T/A/R 각 1~2문장 의무)** — 현행 프롬프트의 "자연스럽게 녹여내기"는 약해서 구조 빈약 원인
- 이력서 청크에서 **실제 프로젝트명/숫자/기술명 1개 이상 인용 필수**
- 마크다운·나열식 금지 (현행 유지)
- 6~10문장 (현행 5~8 → 약간 상향)

## 6. API / 데이터 계약

### 6.1 요청 (변경 없음)

```json
POST /api/model-answer/generate
{
  "resumeId": "uuid",
  "jobPostingText": "string | null"
}
```

### 6.2 응답 (변경 없음)

```json
{
  "plan": {"type": "...", "categories": [...], "difficulty": "...", "totalQuestions": 5},
  "questions": [
    {
      "text": "...",
      "source": "resume_based | job_posting",
      "category": "...",
      "difficulty": "...",
      "modelAnswer": "...",
      "keyPoints": [...],
      "answerTips": [...]
    }
  ],
  "activityLogId": "uuid | null"
}
```

**호환성**: 프론트엔드 (`frontend/src/hooks/useModelAnswerStudy.ts`, `[resumeId]/page.tsx`, `history/activity/[id]/page.tsx`) 수정 불필요.

### 6.3 부분 실패 시 응답

일부 모범답안만 실패한 경우:
- 응답 `questions` 배열에서 해당 인덱스 **제외** (빈 슬롯 안 만듦)
- `totalQuestions` 메타는 plan 기준 5 유지하되, 실제 `questions.length`는 그보다 적을 수 있음
- 프론트는 `questions.length`로 순회 — 기존 코드와 호환

## 7. 작업 분해

커밋 단위별로 분리 (사용자 선호 반영).

### Task 1 — 스펙 문서 작성 (본 문서)
**파일**: `docs/superpowers/specs/2026-04-14-model-answer-quality.md`
**커밋**: `docs: model-answer 품질 개선 스펙`

### Task 2 — 프롬프트 리팩토링
**파일**: `backend/app/prompts/model_answer.py`
**변경**:
- 기존 `MODEL_ANSWER_RESUME_PROMPT` / `MODEL_ANSWER_WITH_JOB_PROMPT` → `QUESTION_GEN_RESUME_PROMPT` / `QUESTION_GEN_WITH_JOB_PROMPT` 로 교체 (질문만)
- 신규 `MODEL_ANSWER_PROMPT` (질문 1개 + 이력서 컨텍스트 → 답변/팁)
- STAR 구조 명시, 인용 필수, 6~10문장 규칙 강화
**커밋**: `refactor(model-answer): 2-step 프롬프트 분리 + STAR 강화`

### Task 3 — 라우터 2-step + RAG 통합
**파일**: `backend/app/routers/model_answer.py`
**변경**:
- 질문 batch 호출 (QUESTION_GEN_* 프롬프트, `call_llm_json`)
- `has_resume_embeddings`로 RAG 모드 분기
  - RAG 모드: 질문별 `search_resume(query=q.text, top_k=3)` → 청크 포맷팅
  - Fallback: `json.dumps(parsed_data)` 한 번 직렬화
- `asyncio.gather(*[gen_answer(q) for q in questions], return_exceptions=True)`
- 성공 항목만 merge. 전부 실패 → `HTTPException(500, "AI 생성에 실패했습니다")`
- 크레딧 차감 + ActivityLog 저장 (현행 로직 유지)
**커밋**: `feat(model-answer): 2-step 생성 + 이력서 RAG 주입`

### Task 4 — 스모크 테스트
**실행**:
```bash
docker compose build backend
docker compose up -d backend nginx nginx-prod
docker compose logs -f backend | grep -E "model_answer|embed_resume"
```
**검증**:
- 로그인 상태에서 `/interview/model-answer` → 모범답안 생성 1회
- `questions.length == 5` 및 각 modelAnswer 6~10문장 확인
- `has_resume_embeddings=true`면 `search_resume` 로그 5회, `false`면 fallback 경로
- 로그에 "AI 생성에 실패했습니다" 없음
**커밋**: (변경 없으면 커밋 X. 버그 발견 시 수정 커밋)

## 8. 롤백 플랜

- 프롬프트/라우터 두 파일 단일 커밋으로 되돌릴 수 있게 Task 2, 3을 각각 단일 커밋으로 유지
- 이력서 RAG 미사용 시에도 동작(fallback)하므로 이력서 임베딩 기능 장애와 격리됨
- ActivityLog 스키마·응답 계약 변경 없음 → 프론트 롤백 불필요

## 9. 검증 체크리스트

- [ ] 질문 batch 프롬프트가 text/source/category/difficulty 4필드만 요구
- [ ] 모범답안 프롬프트에 STAR 구조 명시 + 인용 필수 규칙
- [ ] `has_resume_embeddings == True`이면 질문별 청크 top-3 주입 로그 확인
- [ ] `has_resume_embeddings == False`이면 parsedResume JSON fallback 경로 타는지 확인
- [ ] 모범답안 1개 실패해도 나머지 반환되는지 (인위 에러 주입 테스트)
- [ ] 전부 실패 시 500 + 크레딧 미차감
- [ ] 성공 시 ActivityLog 저장 + 히스토리 페이지에서 조회 가능
- [ ] 응답 스키마 프론트 호환 (필드명 변경 없음)
