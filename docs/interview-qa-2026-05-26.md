# VoicePrep 면접 질문 & 코드 기반 모범 답안 (27개)

> 모든 답안은 실제 코드/측정 데이터에 근거합니다. `file:line`은 면접 중 즉답용 레퍼런스입니다.
> 핵심 원칙: **마케팅 수치 대신 실측, LLM을 신뢰하지 않고 서버가 강제하는 구조**.

---

## 1. 프로젝트 개요

### ⭐⭐⭐ Q1. VoicePrep이 어떤 서비스인지 설명해주세요

**한 줄**: "타이핑이 아니라 실제로 말하며 연습하는 AI 기술 면접 코치"입니다.

핵심은 두 가지 모드입니다.
- **AI 코치 면접**: 이력서를 RAG로 기억하고, 실제 면접관처럼 **훑기(Scan) → 딥다이브(Dive)** 2페이즈로 동적 질문을 생성합니다. 답변 depth가 낮으면 꼬리질문으로 더 파고듭니다.
- **모범답안 학습**: AI가 질문+모범답안을 생성하면 음성으로 답해보고 정답을 공개합니다.

차별점은 "음성 우선"입니다. 답변을 음성으로 하고(Web Speech API + 선택적 Whisper), 질문도 TTS로 듣습니다. 그래서 TTS 응답속도(TTFA)와 음성 인식 노이즈 보정이 제품 품질의 핵심이었습니다.

---

### ⭐⭐⭐ Q2. 전체 아키텍처를 설명해주세요

4개 컨테이너를 nginx 리버스 프록시로 묶은 구조입니다.

```
[Browser] → nginx → /api/auth/*  → frontend (Next.js, NextAuth)
                  → /api/*       → backend (FastAPI)
                  → /            → frontend
backend → tts (OpenAI gpt-4o-mini-tts 래퍼)
backend → Supabase Postgres (pgvector)
```

- **frontend** (`Next.js 15 App Router`): UI + NextAuth v5 인증만. 비즈니스 로직 없음.
- **backend** (`FastAPI`): API, LangGraph 에이전트, RAG, 프롬프트 전부.
- **tts**: OpenAI TTS 래퍼 (실패 시 edge-tts 폴백).
- **DB**: Supabase 호스팅 Postgres + pgvector 확장.

**인증 흐름이 특이한 점**: 프론트 NextAuth가 발급한 JWE 세션 토큰을 백엔드가 **직접 복호화**합니다. Node.js 서브프로세스 없이 `HKDF-SHA256`으로 키를 유도하고 `joserfc`로 복호화 (`backend/app/dependencies.py:16-69`). salt가 쿠키 이름이라 dev(`authjs.session-token`)/prod(`__Secure-authjs.session-token`) 둘 다 지원합니다.

Dev(포트 81)/Prod(포트 82)는 컨테이너/네트워크/볼륨 완전 격리, 배포는 로컬 PC + Cloudflare Tunnel(`jachana.com`)입니다.

---

## 2. LangGraph & Agent

### ⭐⭐⭐ Q3. Planner-Executor 2단계로 재설계한 이유는?

**패턴 명명**: **Plan-and-Execute** 패턴입니다. Scan은 **Hybrid Planner (LLM Suggester + Rule Validator)**, Dive는 **Rule-based Planner**. Executor는 모두 LLM. 의도적 분리입니다.

**문제 정의**
원래 단일 LLM 호출로 "면접 알아서 진행해"를 시도했더니 — agent autonomy는 높았지만 (1) 같은 입력에 다른 출력(**non-determinism**), (2) 질문 개수 폭주(**unbounded generation**), (3) **선정 근거 추적 불가**(black-box planning)였습니다. 이건 LLM agent의 알려진 실패 모드입니다.

**설계 원칙**
> "Intelligence without structure cannot scale" — 그래서 **structure는 코드, intelligence는 LLM**으로 분리.

- **무엇을 물을지 (planning)**: 구조화된 코드 (`plan_builder.py`)
- **어떻게 물을지 (execution / generation)**: LLM (`questioner.py`)
- **그래프 라우팅 (control flow)**: LangGraph 조건부 엣지 (`graph.py`)

**Scan 단계 — Hybrid Planner**
1. **LLM Suggester** (`suggest_scan_candidates_llm`): 면접관이 보는 **7가지 signal** (impact / complexity / ownership / scope / jd_match / red_flag / measurable)로 후보 5개를 추천. **JSON mode + structured output**(`{candidates: [...]}`)으로 schema enforcement. `temperature=0.2`로 mild diversity 허용.
2. **Rule Validator** (`enforce_scan_rules`): 5개 후보 중 **top-2 (jd_match) + bottom-1 (jd_unmatched)** 슬롯에 맞춰 3개로 정제 — schema 위반·signal 누락에 대한 **guard rail**.
3. **Graceful degradation**: LLM 호출 실패/JSON 깨짐/후보 부족 시 기존 rule-based planner(`build_scan_plan`)로 **자동 폴백**. 최종 plan에 `source` 메타데이터(`llm / llm+rule_fill / rule_fallback`) 부착 — observability 확보.

**Dive 단계 — Rule-based Planner**
- `build_dive_plan`: scan evaluation의 `depth` 점수 기준으로 weakness(min) + strength(max) 2주제 선정. **LLM-as-judge**가 채점하면 그 결과를 코드가 argmin/argmax로 단순 집계. dive 라운드 상한(`MAX_DIVE_DEPTH=3`)도 코드가 강제 — **inference-time controller**.

**얻은 것 (Why Hybrid Beats Pure-LLM)**
- **Bounded behavior**: 질문 수 3~9 결정론, **token budget 예측 가능**
- **Cost**: planner 호출이 Suggester 1회로 압축 (vs 매턴 plan 재생성)
- **Explainability**: `signals` 배열 + `rationale` 필드로 "왜 이 질문?" 추적 — **LLM agent의 고질 약점인 audit trail 해소**
- **Reliability**: rule fallback으로 LLM 다운/quota 초과에도 동작 — **graceful degradation**
- **Flexibility 회복**: 7가지 signal 모두 LLM이 평가 — rule-only로는 JD 매칭 1축만 봤던 한계 보완

**Trade-off (선제 인정)**
- **LLM Suggester는 비결정적**: 동일 이력서에 후보 셋이 흔들릴 수 있음. Rule Validator가 구조는 강제하지만 후보 변동성 자체는 못 막음. → reproducibility ↔ flexibility의 의도된 trade-off.
- **Dive는 여전히 1축 휴리스틱**: depth-only는 hand-crafted heuristic이고 data-driven 검증은 아님. **multi-signal scoring (가중 평균)** 또는 **learned ranker**가 다음 단계 후보.
- **Bitter Lesson 관점 인정**: 장기적으론 hand-crafted rule이 learned approach에 밀릴 수 있음. 현재는 평가 데이터 부족으로 rule이 정당. 데이터 모이면 **GraphPlanner 류 learned planner** 검토.

---

### ⭐⭐⭐ Q4. Planner와 Executor 각각의 역할은?

**Planner (Hybrid + Rule, `plan_builder.py`)**

| 함수 | 타입 | 역할 |
|------|------|------|
| `suggest_scan_candidates_llm` | LLM | 7-signal multi-criteria scoring으로 후보 5개. JSON mode + structured output |
| `enforce_scan_rules` | Pure code | 후보 → top-2 (jd_match) + bottom-1 (jd_unmatched) 슬롯 강제. **post-LLM validator** |
| `build_scan_plan_hybrid` | Orchestrator | Suggester → Validator → rule fallback의 graceful degradation 체인 |
| `build_scan_plan` | Pure code | **LLM fallback** — `techStack ∩ matched_skills` 점수 기반 rule-only (legacy 살림) |
| `build_dive_plan` | Pure code | scan eval의 depth 점수로 argmin=weakness / argmax=strength 2주제 |

**Executor (LLM, `questioner.py`)**

| 함수 | 역할 |
|------|------|
| `generate_scan_question` | scan 슬롯 + RAG context (이력서 임베딩 top-3)로 질문 generation |
| `generate_dive_question` | dive 주제 + scan answer를 condition으로 deep-dive 질문 generation |
| `decide_in_topic` | 답변 평가 후 `dig_deeper / next_topic / end` 결정 — **LLM controller**. 단 `depth >= MAX_DIVE_DEPTH`면 코드가 강제 next_topic (guard rail로 LLM judgment override) |
| `generate_dig_deeper` | 꼬리질문 generation (depth ladder: what → why → tradeoffs) |

**평가 (`evaluation.py`) — LLM-as-Judge**
- 5축 채점 (clarity 30% / accuracy 25% / practicality 25% / depth 15% / completeness 5%)
- LLM 출력은 0~100 score만 받고 **weighted overall은 서버에서 계산** — LLM 산수 신뢰 안 함
- `_normalize_evaluation` + `_quality_cap`으로 저품질 답변 hard cap (post-LLM normalization)

**한 줄 정리**
**"Planning은 hybrid (LLM scoring + rule structure), Execution은 LLM, Routing은 code"** — 각 책임을 분리해 **debuggability, cost, reliability**를 동시에 잡았습니다.

---

### ⭐⭐ Q5. LangGraph의 State / Node / Edge를 어떻게 활용했나요?

- **State** (`state.py:21-75`): `InterviewState` TypedDict 하나에 세션 전체 상태. `phase`, `scan_plan`, `dive_plan`, `scan_evaluations`, `current_scan_idx/dive_idx/dive_depth`. 각 노드는 state를 받아 새 state를 반환 (불변, side-effect 없음).
- **Node**: `load_profile → fit_analysis → build_scan_plan → scan_ask`(시작 그래프), `evaluate / scan_next / decide_in_topic / dive_ask / update_profile / generate_report`(답변 그래프).
- **Edge**: 핵심은 2개의 조건부 엣지입니다.
  - `_route_phase`: phase가 scan→`scan_next`, dive→`decide_in_topic`, done→`update_profile` (`graph.py:546`).
  - `_route_action`: `next_action` 값으로 `scan_ask / build_dive_plan / dive_ask / end` 분기 (`graph.py:553`).

이 조건부 엣지가 "주제 내에서 더 파기 vs 다음 주제로" 루프를 만듭니다.

---

### ⭐ Q6. 왜 LangChain이 아니라 LangGraph인가요?

면접은 선형 체인이 아니라 **상태를 들고 도는 루프**라서입니다.

- 답변 평가 → depth 보고 "더 팔지 넘어갈지" 분기 → 같은 주제 반복. 이건 LangChain의 순차 체인보다 **그래프의 조건부 엣지**가 자연스럽습니다.
- 상태가 DB에 영속화돼야 합니다. 면접은 HTTP 요청마다 끊기므로(`/start`, `/answer`, `/skip` 각각 별도 그래프 실행), state를 직렬화해 `agent_interview_sessions`에 저장하고 다음 요청에 복원합니다. LangGraph의 state-in/state-out 모델이 이 영속화에 맞습니다.
- 노드 단위 트레이싱: `tracing.py`의 `trace_graph/trace_tool`로 LangSmith에 노드별 기록 + run_id를 프론트에 반환.

LangChain의 추상화는 이 동적 루프에 오히려 방해됐습니다.

---

## 3. RAG / pgvector

### ⭐⭐⭐ Q7. 이력서 4가지 청크 타입이 뭐고 왜 나눴나요?

`summary / project / experience / education` 4종입니다 (`resume_memory.py:18`). **skills는 일부러 제외**했습니다.

이유는 검색 단위의 의미 수준이 다르기 때문입니다.
- **project/experience**: 각 프로젝트·경력을 description + achievements 통합해 한 청크로. 딥다이브 질문 시 이 단위로 retrieve해야 "그 프로젝트에서 X를 어떻게 했나요"가 정확해집니다.
- **summary**: 커리어 개요, 첫 질문 컨텍스트.
- **education**: 배경 맥락.
- **skills 제외**: 개별 스킬 태그("React", "Docker")는 임베딩하면 노이즈만 늘고 중복성이 높아 검색 품질을 떨어뜨립니다.

각 청크엔 metadata(`section`, `index`, `name/company` 등)를 붙여 어느 프로젝트인지 역추적 가능합니다 (`resume_memory.py:55-158`).

---

### ⭐⭐ Q8. 임베딩 모델 / 차원 / 청크 사이즈는?

- **모델**: `text-embedding-3-small` (`embeddings.py:12`)
- **차원**: 1536 (`VECTOR(1536)` 컬럼)
- **청크 방식**: 토큰 고정 크기가 아니라 **이력서 구조 단위**로 쪼갭니다. 프로젝트 1개 = 1청크(설명+성과 통합), 경력 1개 = 1청크. 의미 경계가 명확해 고정 청크보다 검색 정확도가 좋습니다.

small 모델 선택 이유는 비용/속도입니다. 면접 질문마다 쿼리 임베딩을 만들어야 해서 large는 과합니다.

---

### ⭐⭐ Q9. pgvector 인덱스는 HNSW? IVFFlat? 선택 이유는?

**IVFFlat, `lists = 100`, `vector_cosine_ops`** 입니다 (`db/migrations/2026-04-13-resume-embeddings.sql:21`).

```sql
CREATE INDEX idx_resume_emb_vec ON resume_embeddings
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
```

선택 이유:
- 데이터 규모가 사용자×이력서 단위로 작습니다(수천~수만 벡터). IVFFlat은 이 중간 규모에 충분하고 인덱스 빌드가 빠릅니다.
- HNSW는 100만+ 벡터에서 빛나지만 메모리·빌드 비용이 큽니다. 우리 규모엔 과투자입니다.
- 거리 연산은 cosine(`<=>`)을 쓰고 `1 - distance`로 유사도 변환합니다 (`resume_memory.py:247-255`).

**솔직한 한계**: `lists=100`은 데이터가 적을 땐 오히려 recall이 떨어질 수 있어, 규모가 커지면 HNSW 전환을 고려할 지점입니다.

---

### ⭐⭐ Q10. 왜 top-3인가요? top-5는 안 좋았나요?

이력서 RAG는 `top_k=3` 기본값입니다 (`resume_memory.py:239`). 프로필 RAG는 `TOP_K=10`으로 다릅니다.

- **이력서 top-3**: 질문 생성 시 **정밀도** 중심. scan/dive 플랜이 이미 "어느 프로젝트"인지 정해놓은 상태라, 그 프로젝트 관련 청크 3개면 충분합니다. 더 넣으면 무관한 청크가 프롬프트를 오염시키고 토큰만 늘립니다.
- **프로필 top-10**: 사용자 전체 맥락(강점/약점/패턴)은 **포괄성**이 중요해 더 많이 가져옵니다.

즉 top-k는 "검색 목적이 정밀도냐 포괄성이냐"로 갈라 다르게 잡았습니다.

---

## 4. 사용자 메모리

### ⭐⭐ Q11. 사용자 메모리는 어떻게 추출/저장하나요?

세션 종료 시 `save_session_insights`가 대화+평가를 LLM에 넣어 `strengths / weaknesses / patterns` JSON으로 추출합니다 (`profile_memory.py:158-218`). 프롬프트엔 "이번 세션에서 **새로 발견한 것만**, 구체적·기술적으로"라고 명시합니다.

저장은 4개 카테고리(`strength/weakness/pattern/context`)로 `user_profile_embeddings`에 임베딩과 함께 upsert (`profile_memory.py:8`).

---

### ⭐⭐ Q12. 메모리가 계속 쌓이면 토큰 비용을 어떻게 관리하나요?

핵심은 **upsert with similarity threshold**입니다 (`profile_memory.py:55-116`).

새 인사이트를 저장할 때 같은 카테고리에서 **코사인 유사도 > 0.85**인 기존 항목이 있으면 INSERT가 아니라 UPDATE합니다.

```sql
SELECT id, 1 - (embedding <=> CAST(:emb AS vector)) AS similarity
FROM user_profile_embeddings WHERE "userId"=:uid AND category=:cat
ORDER BY embedding <=> CAST(:emb AS vector) LIMIT 1
```

그래서 "React 상태관리에 약함"류 인사이트가 매 세션 중복 누적되지 않고 갱신만 됩니다. 그리고 주입 시엔 전체가 아니라 현재 이력서/JD 쿼리로 **top-10만 retrieve**하므로 메모리가 1000개여도 프롬프트엔 10개만 들어갑니다.

---

### ⭐⭐ Q13. 다음 세션에 메모리는 어떻게 주입되나요?

면접 시작 시 `load_user_profile`이 동작합니다 (`profile_memory.py:118-155`):
1. 현재 이력서 skills+projects + JD position으로 검색 쿼리 구성.
2. `search_profile`로 top-10 유사 인사이트 retrieve.
3. 카테고리별 dict로 정리해 질문 프롬프트의 `strengths/weaknesses/patterns` 슬롯에 주입.

즉 "지난번에 약했던 부분"을 면접관이 기억하고 그 주변을 더 파는 효과가 납니다. 이 슬롯들은 프롬프트의 정적 prefix에 들어가 캐싱 대상이 됩니다.

---

## 5. 채점 시스템

### ⭐⭐⭐ Q14. LLM 단일 채점이 신뢰성 낮은 이유는?

세 가지를 직접 겪었습니다.
1. **산술 오류**: `0.3×clarity + 0.25×accuracy...` 가중합을 LLM이 틀립니다. 개별 점수와 종합 점수가 안 맞습니다.
2. **저품질 답변 관대함**: "몰라요" 같은 단답에도 LLM이 후하게 점수를 줍니다. 테스트에서 실제로 90점을 주는 케이스가 있었습니다 (`test_evaluator_normalize.py:25`).
3. **일관성 부재**: 같은 답변도 호출마다 점수가 출렁입니다.

그래서 **LLM은 항목별 raw 점수만 내고, 집계와 가드는 서버가 강제**하는 구조로 갔습니다.

---

### ⭐⭐⭐ Q15. 결정적 가중 합산 구조를 설명해주세요

`_normalize_evaluation`의 3단계 후처리입니다 (`evaluation.py:91-142`):

1. **Clamp**: 각 항목 점수를 0~100으로 정규화 (비숫자→0).
2. **Quality cap**: `_quality_cap(answer)`가 반환한 상한 이하로 강제.
3. **overallScore 서버 재계산**:
```python
overall = sum(scores[k] * w for k, w in SCORE_WEIGHTS.items())
evaluation["overallScore"] = int(round(overall))
```

가중치는 코드 상수입니다 (`evaluation.py:14-20`):
- clarity 30% / accuracy 25% / practicality 25% / depth 15% / completeness 5%

**LLM이 준 overallScore는 완전히 버립니다.** 최종 리포트의 집계 수치도 서버 계산값으로 덮어씁니다 (`evaluation.py:224-230`). 심화 면접은 depth를 15→25%로 올린 별도 가중치를 씁니다.

---

### ⭐⭐ Q16. guardrail의 발동 조건과 처리는?

`_quality_cap`의 계단식 임계값입니다 (`evaluation.py:36-62`):

| 조건 | 상한(cap) |
|------|----------|
| 빈 답변 | 0 |
| 공백 제거 10자 미만 | 15 |
| 고유 문자 비율 < 0.25 (예: "제일제일제일") | 20 |
| 고유 토큰 비율 < 0.35 | 25 |
| 고유 토큰 < 5개 | 30 |

cap이 걸리면 모든 항목 점수를 그 값 이하로 누르고, LLM이 제시한 `demonstratedKeywords/missingKeywords`도 빈 배열로 무효화합니다 (`evaluation.py:115-125`).

추가로 백엔드 진입점에서 **10자 미만 또는 고유 토큰 3개 미만이면 HTTP 400으로 즉시 거부**합니다 (`agent_interview.py:41-54`). 음성 인식 노이즈/단답이 평가 파이프라인에 들어오기 전에 막는 1차 방어선입니다.

---

## 6. 비용 최적화 (Prompt Caching)

### ⭐⭐⭐ Q17. OpenAI Prompt Caching 동작 원리는?

OpenAI는 **prompt의 prefix가 1024 토큰 이상이고 호출 간 동일하면 자동으로 캐시 적중**시킵니다. 적중분은 input 토큰 단가의 50% (gpt-4o-mini 기준 $0.15 → $0.075/1M).

그래서 메시지를 prefix가 안 변하도록 구조화하는 게 전부입니다 (`llm_client.py:90-112`):
```
[system] 페르소나/출력포맷 (고정)
[user]   cached_context: 루브릭+이력서청크+JD+플랜 (세션 불변, ~1050토큰)
[assistant] "Understood. Ready for turn-specific input." (ACK)
[user]   variable: 턴별 phase/idx/depth (변동)
```
앞 3개가 세션 내내 동일해 캐시 적중하고, 마지막 variable만 매 턴 바뀝니다.

---

### ⭐⭐⭐ Q18. 시스템 프롬프트의 정적/동적 영역을 어떻게 나눴나요?

`build_question_messages`가 stable/variable 두 덩어리를 반환합니다.
- **정적(stable, 캐싱 대상)**: 채점 루브릭, 페르소나, 이력서 RAG 청크, JD, scan/dive 플랜, 프로필 인사이트. 세션 동안 안 변합니다.
- **동적(variable)**: 현재 phase, scan/dive 인덱스, 대화 히스토리 등 턴마다 바뀌는 것.

`INTERVIEWER_QUESTION_PROMPT_SLIM`도 앞쪽(지원자 요약~프로필)이 prefix, `{conversation_history}`가 suffix로 분리돼 있습니다 (`agent.py:68-111`). 이 구조 분리가 커밋 `8be90cf`의 핵심이었습니다.

---

### ⭐⭐⭐ Q19. 11% 절감을 어떻게 측정했나요?

실측 스크립트(`scripts/measure_prompt_cache.py`)로 7턴 면접 세션을 시뮬레이션하고 OpenAI 응답의 `prompt_tokens_details.cached_tokens`를 집계했습니다 (`docs/prompt-cache-measurement-2026-04-28.md`).

결과:
- 7턴 중 turn 4, 6에서 각 1024 토큰 캐시 적중 → **hit ratio 27.5%** (2048/7455).
- 비용: 캐시 미적용 $0.001388 vs 적용 $0.001235 → **11.1% 절감**.

가격표(input $0.15 / cached $0.075 / output $0.60 per 1M)를 코드에 박아 계산했습니다 (`measure_prompt_cache.py:100`). **마케팅 수치가 아니라 토큰 단위 실측**이라는 점을 강조합니다. prefix를 2~3k로 더 키우면 절감폭이 커집니다.

---

### ⭐⭐ Q20. gpt-4o-mini를 선택한 이유는?

`AGENT_MODEL` 기본값이 `gpt-4o-mini`입니다 (`config.py:17`), `.env`로 런타임 교체 가능 (`llm_client.py:142`).

이유:
- 한 면접에 7+회 LLM 호출(scan 3 + dive 4)이라 호출당 비용 민감.
- 한국어 + JSON 출력 안정성이 충분.
- prompt caching 지원 모델.
- 채점 신뢰성은 모델이 아니라 **서버 가드(Q14~16)**로 확보하므로 굳이 비싼 모델이 필요 없습니다.

모델을 환경변수로 분리해둬서 평가 품질이 부족하면 `gpt-4.1-mini` 등으로 즉시 올릴 수 있습니다.

---

## 7. TTFA / TTS

### ⭐⭐⭐ Q21. TTFA가 뭐고 왜 중요한가요?

TTFA = **Time To First Audio**, 질문 텍스트가 준비된 뒤 사용자가 **첫 소리를 듣기까지** 걸리는 시간입니다.

음성 면접 제품에선 이게 체감 품질을 좌우합니다. 면접관이 질문하기까지 3초씩 침묵이 흐르면 어색하고 몰입이 깨집니다. 전체 오디오 완성 시간(total)보다 **첫 바이트까지**가 중요해서 TTFA를 핵심 지표로 잡았습니다.

---

### ⭐⭐⭐ Q22. TTFA 64% 개선을 어떻게 했나요?

병목이 5군데의 **버퍼링**이었습니다 (`docs/tts-latency-optimization-2026-04-15.md`):
1. tts 서비스가 OpenAI 응답을 `b"".join()`으로 전체 모은 뒤 반환
2. 백엔드가 `res.content`로 전체 바디 읽음
3. 백엔드가 `Response(content=...)`로 Content-Length 완성 후 전송
4. 프론트가 `res.blob()`로 전체 수신 후 재생
5. 인코딩 포맷

수정:
- **엔드투엔드 스트리밍**: tts는 `StreamingResponse` + OpenAI `iter_bytes()` 즉시 yield (`tts/main.py:119`), 백엔드는 `httpx.stream()` + 패스스루 `StreamingResponse` (`speech.py:79`). nginx도 `proxy_buffering off` (SSE/스트림용).
- **프론트 MSE 점진 재생**: `MediaSource` + `SourceBuffer.appendBuffer`로 받는 즉시 디코딩, 미지원 환경은 blob 폴백.

결과 long(129자) 텍스트에서 **3.32s → 1.18s, 64% 단축**.

---

### ⭐⭐⭐ Q23. 64%는 p50? p95? 평균? (측정 기준)

**솔직하게**: 부하 분포 기반 p50/p95가 아니라, **3가지 고정 길이(short 27자 / medium 63자 / long 129자) 텍스트로 측정한 대표값**입니다.

| 길이 | Before | After | 개선 |
|------|-------:|------:|-----:|
| short | 1.55s | 1.23s | 21% |
| medium | 1.99s | 1.14s | 43% |
| long | 3.32s | 1.18s | **64%** |

64%는 **long 텍스트의 단일 측정 개선율**입니다. 개선폭이 길이에 비례하는 이유는, 기존 구조에서 긴 텍스트일수록 "전체 완성 대기" 시간이 길었기 때문입니다. 스트리밍이라 After는 길이와 무관하게 ~1.2s로 평탄해졌습니다. 면접에서 "64%는 최선 케이스(long)이고, short은 21%"라고 정직하게 말하는 게 좋습니다.

---

### ⭐⭐ Q24. 폴백 엔진은 어떤 조건에 발동되나요?

**OpenAI TTS 호출 자체가 실패(예외)하면** edge-tts로 폴백합니다 (`speech.py:33-38, 68-75`).

```python
try:
    upstream = await client.send(req, stream=True)   # OpenAI
except Exception:
    logger.warning("OpenAI TTS failed, falling back to edge-tts")
    return StreamingResponse(_edge_stream(cleaned), media_type="audio/mpeg")
```

edge-tts는 한국어 음성 `ko-KR-HyunsuNeural`을 씁니다. OpenAI 쿼터 초과/네트워크 오류 시에도 면접이 **무중단**되도록 한 안전장치입니다. 다만 페르소나 톤 지시는 edge-tts에선 적용되지 않습니다.

---

## 8. SSE / 인프라

### ⭐⭐ Q25. WebSocket이 아닌 SSE를 선택한 이유는?

면접 흐름이 **단방향 서버→클라이언트 스트림**이기 때문입니다.

`/start`, `/answer`, `/skip` 모두 `EventSourceResponse`로 구현 (`agent_interview.py`). 한 요청에 `status → session → question` 또는 `evaluation → action` 이벤트를 순차 push합니다. 사용자 입력은 다음 HTTP POST로 들어오지 양방향 실시간이 필요 없습니다.

SSE 이점:
- HTTP 표준 → nginx 리버스 프록시/Cloudflare Tunnel과 호환 좋음 (`proxy_buffering off`, `read_timeout 300s`만 설정).
- 브라우저 `EventSource` 내장 + 자동 재연결.
- WebSocket의 핸드셰이크/연결 상태 관리 복잡도 불필요.

진행 상태(`loading_profile → fit_analyzing → generating_question → ...`)를 이벤트로 흘려 로딩 UX도 자연스럽습니다.

---

## 9. 회고

### ⭐⭐ Q26. 가장 어려웠던 부분은?

**LLM 출력을 신뢰할 수 없다는 전제를 코드로 방어하는 일**이었습니다.

처음엔 채점도, 질문 흐름도 LLM에 맡겼는데 점수가 출렁이고("몰라요"에 90점), 질문이 산만했습니다. 그래서:
- 채점 → 항목 점수만 LLM, 가중합·가드·키워드는 서버 강제 (`_normalize_evaluation`).
- 질문 흐름 → 계획은 순수 코드(`plan_builder`), LLM은 슬롯 채우기만.

"LLM을 어디까지 믿고 어디부터 코드로 제약할지" 경계를 긋는 게 가장 어렵고 또 가장 많이 배운 부분이었습니다. 음성 인식 노이즈(반복/단답)를 평가 전에 거르는 가드도 이 맥락에서 나왔습니다.

---

### ⭐ Q27. 다시 만든다면 뭘 바꾸겠나요?

세 가지입니다.
1. **측정을 더 일찍, 더 통계적으로**: TTFA 64%는 고정 3샘플 대표값이라 p50/p95 분포로 못 말합니다. 처음부터 측정 하네스를 깔고 분포로 추적했을 겁니다.
2. **pgvector 인덱스 전략**: 지금 IVFFlat `lists=100`은 데이터 적을 때 recall이 불안할 수 있어, 데이터량에 따라 자동 전환(HNSW) 또는 파라미터 튜닝을 설계에 넣겠습니다.
3. **프롬프트 캐싱을 처음부터 고려한 프롬프트 설계**: 나중에 stable/variable로 쪼개느라 리팩터가 컸습니다(`8be90cf`). 정적/동적 경계를 처음부터 의식했으면 11%보다 더 절감했을 겁니다.
