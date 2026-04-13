# 이력서 기반 RAG 면접 시스템 고도화 (Spec)

- **작성일**: 2026-04-13
- **대상 영역**: 에이전트 면접 (`/agent-interview`)
- **목표**: 이력서를 RAG에 청킹/임베딩하고, JD와 명시적으로 매칭한 뒤, 매 질문마다 직전 답변·매칭 결과 기반으로 관련 이력서 청크를 retrieve 해 면접 질문 품질을 끌어올린다.

## 1. 배경 / 문제 정의

현 에이전트 면접의 RAG는 **"세션 종료 후 LLM이 추출한 인사이트(strength/weakness/pattern)"만** `user_profile_embeddings`에 저장하고, 면접 시작 시 단순 키워드 query 한 번으로 검색한다. 한편 **이력서 본문 자체는 RAG에 들어가지 않으며**, 매 질문 생성 프롬프트에 `json.dumps(resume)` 통째로 주입된다 (`backend/app/agent/interviewer_agent.py:53`).

이로 인해 다음 한계가 있다:

1. **신규 유저 콜드스타트**: 첫 면접 시 RAG에 데이터 없음 (`user_profile_embeddings` 0건 실측 확인).
2. **이력서↔JD 매칭 부재**: 이력서·JD를 LLM에 implicit하게 맡길 뿐, 명시적 gap/focus 추출 단계 없음.
3. **정적 RAG 검색**: `skills[:10] + projects[:3].name + position` 단순 concat query를 시작 시 1회만 실행. 답변에 따라 동적으로 추가 컨텍스트를 가져오지 않음.
4. **프롬프트 비대/희석**: 시니어 이력서(프로젝트 10개+) 케이스에서 토큰 10k+ 차지, 중요 섹션이 묻힘.

## 2. 비목표 (YAGNI)

- JD 청킹/임베딩 (Fit Analysis는 LLM 호출 1회로 처리)
- skills 임베딩 (코드 매칭이 더 정확하고 저렴)
- achievements 분리 청킹 (맥락 손실)
- 임베딩 동기 처리 (UX 손실)
- 임베딩 재시도 큐 (다음 면접 시 fallback이 안전망)
- 기존 `user_profile_embeddings` 마이그레이션 (그대로 두고 새 테이블만 추가)

## 3. 핵심 의사결정 요약

브레인스토밍 단계에서 확정된 6개 결정:

| # | 결정 사항 | 결정 내용 | 채택 이유 (대안 대비) |
|---|---|---|---|
| D1 | **임베딩 타이밍** | 이력서 저장 시 비동기 BackgroundTask + 면접 시작 시 임베딩 없으면 JSON fallback | 동기 임베딩(저장 API 3초+ 지연·OpenAI 장애 전파)·lazy 임베딩(첫 면접 시작 3~5초 지연) 대비 UX 손실 0. 누락 케이스는 fallback이 현재 동급 품질 보장 |
| D2 | **저장 스키마** | 새 테이블 `resume_embeddings` (resumeId FK CASCADE) | 기존 `user_profile_embeddings` 카테고리 확장 안(이력서 삭제 cascade 수동)·JD 임베딩 별도 테이블 안(YAGNI) 대비 관심사 분리 + 정합성 자동 |
| D3 | **청킹 단위** | summary / project / experience / education 만 임베딩, skills는 임베딩 제외 (코드로 직접 처리). 청크 1개 = 한 프로젝트/경력 전체 (description + achievements 통합) | 아이템 세분화(achievements 분리)는 맥락 손실. skills 단어 임베딩은 의미 벡터가 약함 → JD vs resume.skills 교집합 코드 계산이 더 정확/저렴 |
| D4 | **Fit Analysis 결과 스키마** | `skill_match`(코드 산출) + `focus_topics`(LLM 산출, 3~5개) + `avoid_topics`(LLM 산출). LLM은 "맥락 해석"만, 키워드 비교는 결정적 코드 | 풍부한 5필드(LLM이 억지로 채움)·질문 가이드 2필드(리포트 활용 정보 손실) 대비 균형 |
| D5 | **검색 query 동적화** | 매 질문 생성 직전 자동 baseline 검색. query = `focus_topics[i]` 우선, 없으면 `current_answer`, 없으면 `summary`. profile insights는 시작 시 1회 로드 유지 | Planner 결정형(이력서 청크는 거의 항상 유용한데 옵션 처리)·하이브리드(과한 복잡도) 대비 단순+예측 가능 |
| D6 | **프롬프트 슬림화** | 임베딩 있음: `summary + skills 리스트 + resume_chunks(top3) + fit_analysis + insights + history`. 임베딩 없음: `json.dumps(resume) + fit_analysis + insights + history` (현 동급 fallback) | 완전 슬림화(면접관이 이력서 윤곽 모름)·항상 JSON(슬림화 무의미) 대비 토큰 절약 + 안전망 |

## 4. 아키텍처

### 4.1 컴포넌트 추가/변경

```
backend/app/agent/
  resume_rag.py        ← 신규
                          - chunk_resume(parsed_data: dict) -> list[Chunk]
                          - embed_resume_async(resume_id, user_id) -> None  (BackgroundTask)
                          - search_resume(user_id, resume_id, query, top_k=3) -> list[dict]
                          - has_resume_embeddings(resume_id) -> bool
  fit_analyzer.py      ← 신규
                          - compute_skill_match(resume_skills, jd_skills) -> dict | None  (코드)
                          - generate_focus_topics(resume_summary, projects, jd) -> dict   (LLM)
                          - run_fit_analysis(resume, jd) -> FitAnalysis
  nodes.py             ← 변경
                          - load_profile 직후 fit_analysis 노드 추가
                          - generate_question 진입 시 search_resume 호출 (임베딩 있을 때만)
  interviewer_agent.py ← 변경
                          - generate_question 시그니처: + resume_chunks, + fit_analysis
                          - 임베딩 유무에 따라 다른 프롬프트 분기
  state.py             ← 변경
                          - + fit_analysis: dict | None
                          - + current_resume_chunks: list[dict]
                          - + has_resume_embeddings: bool

backend/app/prompts/agent.py
  INTERVIEWER_QUESTION_PROMPT_SLIM     ← 신규 (임베딩 있음 케이스)
  INTERVIEWER_QUESTION_PROMPT_FALLBACK ← 신규 (임베딩 없음, 현행 INTERVIEWER_QUESTION_PROMPT 기반)
  FIT_ANALYSIS_PROMPT                  ← 신규

backend/app/routers/resume.py
  POST/PUT 핸들러 → BackgroundTasks 등록 (resume_rag.embed_resume_async)
  DELETE 는 CASCADE로 자동

db/
  resume_embeddings_migration.sql ← 신규
  backfill_resume_embeddings.py   ← 신규 (기존 이력서 백필 1회용)
```

### 4.2 데이터 플로우

#### (a) 이력서 저장/수정 시 임베딩

```
1. router: resume CREATE/UPDATE 정상 처리 (트랜잭션 commit)
2. background_tasks.add_task(embed_resume_async, resume_id, user_id)
3. embed_resume_async:
   a. DELETE FROM resume_embeddings WHERE "resumeId"=resume_id  (재임베딩은 전량 교체)
   b. chunks = chunk_resume(parsed_data)
   c. response = openai.embeddings.create(input=[c.content for c in chunks])  ← 배치 1회
   d. INSERT 모든 청크 (UNIQUE(resumeId, chunk_type, chunk_index) 보장)
4. 실패 시 로그만, 다음 저장/면접 시 재시도
```

#### (b) 면접 시작 (`POST /api/agent-interview/start`)

```
1. load_profile  (기존; user_profile_embeddings에서 인사이트 retrieve)
2. fit_analysis  (신규)
   - skill_match = code(resume.skills, jd.requiredSkills) or null
   - focus_topics, avoid_topics = LLM(resume_summary, projects, jd)
   - state["fit_analysis"] = {...}
   - SSE: {"phase": "fit_analyzed"}
3. has_resume_embeddings 판정 → state["has_resume_embeddings"]
4. generate_question (i=0)
```

#### (c) 매 질문 생성 (`generate_question` 노드)

```
i = state["question_count"]

if state["has_resume_embeddings"]:
    topics = state["fit_analysis"]["focus_topics"]
    if topics:
        query = topics[i % len(topics)]["topic"]
    elif state.get("current_answer"):
        query = state["current_answer"]
    else:
        query = resume.summary or "주요 경험"
    state["current_resume_chunks"] = await search_resume(user_id, resume_id, query, top_k=3)
else:
    state["current_resume_chunks"] = []

result = await interviewer_agent.generate_question(
    resume=resume,
    job_posting=jd,
    user_profile=state["user_profile"],
    fit_analysis=state["fit_analysis"],
    resume_chunks=state["current_resume_chunks"],
    has_embeddings=state["has_resume_embeddings"],
    conversation_history=...
)
```

#### (d) interviewer_agent 프롬프트 분기

```
if has_embeddings and resume_chunks:
    prompt = INTERVIEWER_QUESTION_PROMPT_SLIM.format(
        summary=resume.get("summary", ""),
        skills=", ".join(resume.get("skills", [])),
        resume_chunks=format_chunks(resume_chunks),
        fit_analysis=format_fit(fit_analysis),
        ...
    )
else:
    prompt = INTERVIEWER_QUESTION_PROMPT_FALLBACK.format(
        resume=json.dumps(resume),  # 현행 동작
        fit_analysis=format_fit(fit_analysis),
        ...
    )
```

## 5. 데이터 모델

### 5.1 신규 테이블 `resume_embeddings`

```sql
CREATE TABLE resume_embeddings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "userId" TEXT NOT NULL REFERENCES "users"(id) ON DELETE CASCADE,
    "resumeId" TEXT NOT NULL REFERENCES resumes(id) ON DELETE CASCADE,
    chunk_type VARCHAR(20) NOT NULL CHECK (chunk_type IN ('summary','project','experience','education')),
    chunk_index INT NOT NULL,
    content TEXT NOT NULL,
    embedding VECTOR(1536) NOT NULL,
    metadata JSONB DEFAULT '{}',
    "createdAt" TIMESTAMP(3) DEFAULT NOW(),
    UNIQUE ("resumeId", chunk_type, chunk_index)
);

CREATE INDEX idx_resume_emb_resume ON resume_embeddings ("resumeId");
CREATE INDEX idx_resume_emb_user ON resume_embeddings ("userId");
CREATE INDEX idx_resume_emb_vec ON resume_embeddings
    USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
```

### 5.2 청크 content 포맷

LLM이 검색 결과로 받았을 때 단독으로도 의미가 통하도록 자기-기술적(self-describing) 포맷 사용.

| chunk_type | 포맷 | 예시 |
|---|---|---|
| `summary` | `{summary text}` | `백엔드 3년차, Python/FastAPI 전문. 결제 도메인 경험.` |
| `project` | `[프로젝트] {name} \| {period} \| 기술: {techStack} \| 역할: {role} \| {description} \| 성과: {achievements}` | `[프로젝트] 쇼핑몰 결제 \| 2023.01~2023.06 \| 기술: Next.js, Stripe \| 역할: 백엔드 \| 결제 플로우 설계 및 최적화 \| 성과: 장애율 80% 감소` |
| `experience` | `[경력] {company} {position} \| {period} \| 기술: {techStack} \| {description} \| 성과: {achievements}` | `[경력] 네이버 백엔드 엔지니어 \| 2021.03~2024.02 \| 기술: Python, Kafka \| 추천 서비스 개선 \| 성과: 처리량 2배` |
| `education` | `[학력] {school} {major} {degree} \| {period} \| {gpa}` | `[학력] 서울대 컴퓨터공학 학사 \| 2017.03~2021.02 \| GPA 4.1` |

빈 필드는 해당 segment 자체를 생략 (예: gpa 없으면 마지막 ` \| {gpa}` 생략).

### 5.3 metadata 필드

```json
{
  "section": "project",      // chunk_type 미러 (필터 인덱싱 후보)
  "index": 0,                // chunk_index 미러
  "name": "쇼핑몰 결제",      // project일 때
  "company": "네이버",        // experience일 때
  "period": "2023-01/2023-06"
}
```

## 6. Fit Analysis 결과 스키마

```typescript
type FitAnalysis = {
  skill_match: {
    matched: string[];      // 정규화된 스킬 교집합
    gap: string[];          // JD 요구 - resume.skills
    coverage: number;       // matched.length / jd_required.length (0~1)
  } | null;                 // JD 없으면 null
  focus_topics: Array<{
    topic: string;          // "상태관리 깊이"
    why: string;            // "JD Redux 명시, 이력서 프로젝트에서 Redux 사용"
    priority: "high" | "medium" | "low";
  }>;                       // 3~5개
  avoid_topics: string[];   // ["주니어 React 기초 문법"]
};
```

### 6.1 skill 매칭 정규화

대소문자/구분자 차이 흡수:
- 비교 키 = `s.lower().replace(".", "").replace("-", "").replace(" ", "")`
- 표시 값 = 원본 유지
- 예: `"Next.js"` ↔ `"NextJS"` ↔ `"next js"` 동일 처리

## 7. API/Router 변경

| 엔드포인트 | 변경 |
|---|---|
| `POST /api/resume` | 응답은 그대로. 끝에 `background_tasks.add_task(embed_resume_async, ...)` |
| `PUT /api/resume/{id}` | 동일 |
| `DELETE /api/resume/{id}` | 변경 없음 (CASCADE 자동) |
| `POST /api/agent-interview/start` | `load_profile` 후 `fit_analysis` 노드 호출, 첫 질문 생성 전 `has_resume_embeddings` 판정 |
| `GET /api/admin/resume/{id}/chunks` | (선택, 어드민 디버그용) 청크 미리보기 |

## 8. 에러 처리

| 시나리오 | 동작 |
|---|---|
| OpenAI Embedding API 실패 (저장 시) | BackgroundTask 내 try/except + 로그. resume 저장 응답에 영향 없음. 다음 저장/면접 시 재시도 |
| 부분 임베딩 (청크 일부만 성공) | 발생 안 함 — 배치 1회 호출이라 all-or-nothing |
| `search_resume` 실패 | 빈 배열 반환 → has_embeddings 분기와 무관하게 fallback 프롬프트 사용 |
| Fit Analysis LLM 실패 | `focus_topics=[]`, `avoid_topics=[]`, `skill_match`만 (코드는 항상 성공). 면접은 진행 |
| 이력서 동시 수정 → BackgroundTask 2건 | 각 태스크가 트랜잭션으로 DELETE→INSERT 수행. 마지막 commit이 이김. UNIQUE 제약 위배 시 트랜잭션 rollback + 로그. 재시도는 다음 저장/면접 시 자연 발생 |
| `parsed_data` 비어있음/이상 형식 | `chunk_resume`가 빈 리스트 반환 → 임베딩 0건 INSERT (= 임베딩 없음 상태). fallback 동작 |

## 9. 테스트 전략

자동 테스트 없는 프로젝트 관행에 맞춰 최소화. OpenAI mock 부담 회피.

### 9.1 단위 (필수)

- `chunk_resume(parsed_data)`: 기대 청크 개수/포맷
  - fixture 3종: (a) 풀 이력서 (summary+projects+experience+education), (b) 미니 이력서 (summary만), (c) 빈 parsed_data
- `compute_skill_match(resume_skills, jd_skills)`:
  - 대소문자 ("react" / "React")
  - 구분자 ("Next.js" / "NextJS" / "next js")
  - JD 없을 때 null
  - 빈 교집합

### 9.2 수동 통합 (1회)

- 어드민 페이지 또는 스크립트로 "이력서 ID 입력 → 청크 미리보기 + Fit Analysis 결과" 확인
- 테스트 계정(`test@voiceprep.kr`)으로:
  1. 이력서 저장 → 잠시 후 chunks 미리보기 확인
  2. JD 입력 후 Fit Analysis 결과 확인
  3. 면접 시작 → 첫 질문이 focus_topics와 정합한지 확인
  4. 임베딩 백필 전 이력서로 fallback 동작 확인 (DELETE FROM resume_embeddings WHERE ... 후 면접 시도)

## 10. 마이그레이션

1. `db/resume_embeddings_migration.sql` 적용 (Supabase SQL Editor)
2. 기존 이력서 백필:
   - 옵션: `db/backfill_resume_embeddings.py` 1회 실행 (모든 이력서 순회 → embed_resume_async 직접 호출)
   - 옵션: 백필 안 하고 다음 면접 때 fallback (자연 마이그레이션)
3. 기존 `user_profile_embeddings` 테이블/데이터는 무변경

## 11. 비용/성능 영향

| 항목 | 변화 |
|---|---|
| 이력서 저장 응답 시간 | 변화 없음 (백그라운드 처리) |
| 임베딩 비용 (이력서당 1회) | ~5청크 × ~150토큰 = 750토큰 × $0.02/1M = **$0.000015 / 이력서** |
| 면접 시작 시간 | +2초 (Fit Analysis LLM 호출) |
| 매 질문 시간 | +0.4초 (임베딩 1회 + pgvector 검색) |
| 매 질문 프롬프트 토큰 | 시니어 이력서 케이스 약 -50% (10k → 5k 추정) |
| 임베딩 저장 용량 | 청크당 ~6KB. 이력서 1만 건 × 평균 5청크 = 300MB |

## 12. 향후 확장 (Out of Scope)

- JD 청킹/임베딩 → resume_chunks ↔ jd_chunks 코드 기반 크로스 매칭 (Fit Analysis B안)
- 임베딩 모델 교체 (text-embedding-3-large) 시 resume_embeddings, user_profile_embeddings 일괄 재생성
- 벡터 인덱스 IVFFLAT → HNSW 마이그레이션 (데이터 적재 후 벤치마크 기반)
- 이력서 `parsed_data` 변경 감지 (현재는 PUT 시 무조건 재임베딩) — 텍스트 hash 비교로 노이즈 호출 감축

## 13. 의존성

- `pgvector` 확장 (이미 활성화됨)
- `openai` SDK `embeddings.create` 배치 호출 (이미 사용 중)
- FastAPI `BackgroundTasks` (이미 다른 라우터에서 사용 중)
- 새 Python 의존성 0개
