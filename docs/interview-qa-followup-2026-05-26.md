# VoicePrep 면접 — 답변 프레임 + 꼬리질문 대비 (27개)

> 앞 문서(`interview-qa-2026-05-26.md`)가 "코드 근거 모범답안"이라면, 이 문서는 **말하는 방식(프레임)** + **꼬리질문 대응**입니다.

## 답변 프레임 3종 (질문 유형별로 골라 씀)

| 프레임 | 언제 | 구조 |
|--------|------|------|
| **두괄식 (PREP)** | 기술 설명, "~가 뭐냐", 동작 원리 | **결론 → 근거 → 예시(코드/수치) → 재강조** |
| **트레이드오프** | 기술 선택 이유, "왜 A 말고 B" | **선택지 나열 → 판단 기준 → 결정 → 한계 인정** |
| **STAR** | 경험, 문제해결, 회고, "가장 어려웠던" | **상황 → 과제 → 행동 → 결과(수치)** |

**공통 원칙**: ① 첫 문장에 결론. ② 면접관이 멈추라기 전까지 30~60초. ③ 항상 수치/코드로 착지. ④ 한계를 먼저 인정하면 신뢰가 올라간다.

> 꼬리질문 표기: 🔹 = 예상 질문, → = 대응 요지

---

## 1. 프로젝트 개요

### Q1. VoicePrep이 어떤 서비스인지 — `두괄식`
**결론** "말하며 준비하는 AI 기술 면접 코치"입니다. **근거** 타이핑이 아니라 음성으로 답하고 질문도 TTS로 듣는 게 핵심 차별점. **예시** 두 모드(AI 코치 면접 = Scan→Dive 동적 질문 / 모범답안 학습). **재강조** 그래서 음성 응답속도(TTFA)와 인식 노이즈 보정이 제품 품질의 축이었습니다.

- 🔹 음성이 왜 중요한가? 텍스트가 더 정확하지 않나? → 실전 면접은 말로 한다. 머리로 아는 것과 말로 설명하는 건 다른 능력이라 그걸 훈련하는 게 목적.
- 🔹 경쟁 서비스와 뭐가 다른가? → 대부분 텍스트 Q&A. 우리는 음성 우선 + 이력서 RAG로 "사용자를 기억하는" 동적 면접.
- 🔹 타겟 사용자는? → 개발자 기술면접 준비생. 이력서 기반이라 신입~경력 모두.

### Q2. 전체 아키텍처 — `두괄식`
**결론** nginx 뒤에 frontend/backend/tts 3컨테이너 + Supabase(pgvector) 구조입니다. **근거** frontend는 UI+인증만, 비즈니스 로직은 전부 backend. **예시** 특이점은 프론트 NextAuth JWE 토큰을 백엔드가 직접 복호화(HKDF+joserfc, `dependencies.py:16`). **재강조** Dev/Prod 완전 격리 + Cloudflare Tunnel 배포.

- 🔹 왜 JWE를 백엔드에서 직접 푸나? Node 호출하면 안 되나? → 매 API마다 Node 서브프로세스는 지연·복잡도 큼. joserfc로 Python 네이티브 복호화하면 의존성 하나로 끝남.
- 🔹 frontend/backend를 왜 나눴나? → 인증은 NextAuth 생태계(Prisma), AI 로직은 Python 생태계(LangGraph/pgvector)가 강함. 언어·생태계 경계로 분리.
- 🔹 nginx 없이 직접 통신은? → CORS/쿠키/라우팅(`/api/auth`↔`/api/*`)을 한 곳에서. rate limit도 nginx에서.
- 🔹 단일 PC 배포인데 가용성은? → 한계 인정. 개인 프로젝트라 Cloudflare Tunnel + Docker `restart: unless-stopped`로 자동복구. 트래픽 늘면 클라우드 이전 필요.

---

## 2. LangGraph & Agent

### Q3. Planner-Executor 2단계 재설계 이유 — `STAR`
**패턴 명명** **Plan-and-Execute** 패턴. Scan은 **Hybrid Planner (LLM Suggester + Rule Validator)**, Dive는 Rule-based Planner, Executor는 LLM.
**상황** 초기엔 단일 LLM 호출에 "면접 알아서 진행해" — agent autonomy ↑지만 LLM agent 3대 실패 모드(**non-determinism / unbounded generation / black-box planning**) 동시 발현. **과제** 셋 다 한 번에 해결. **행동** Planning(무엇을)/Execution(어떻게)/Routing(어디로) 책임 분리. Scan은 7-signal **multi-criteria scoring**을 LLM Suggester가 수행, Rule Validator로 **schema enforcement + slot constraint** 적용, LLM 실패 시 **graceful degradation**으로 rule fallback. **결과** bounded behavior(질문 3~9), token budget 예측 가능, signals/rationale로 **explainability 확보(audit trail)**, fallback chain으로 reliability. **Trade-off** Suggester는 비결정적(reproducibility ↔ flexibility 절충), Dive는 hand-crafted heuristic.

- 🔹 그게 진짜 Planner 맞나요? → Plan-and-Execute 패턴에서 Planner는 "task decomposition" 역할이며 구현체는 자유. Classical AI Planning(STRIPS)은 원래 rule-based. 2024년 관용은 LLM Planner를 의미하지만 우리는 **Hybrid Planner**라고 명시.
- 🔹 LLM autonomy를 죽인 거 아닌가? → autonomy는 "generation"에 남김. "selection criteria"만 structured. **Anthropic의 "controllable autonomy"** 관점 — autonomy를 적절히 constrain하는 게 production agent의 핵심.
- 🔹 Plan을 LLM에 통째로 맡기면? → 1차 시도에서 same input → different plan(non-deterministic) 문제로 reproducibility 깨짐. **Routine paper (2026)** 도 동일 문제를 LLM plan → structured planning script 변환으로 풀었는데 41%→96% 향상. 우리 Rule Validator가 그 역할.
- 🔹 Bitter Lesson은? → 인정. learned approach가 장기적으론 hand-crafted를 이김. 우리도 평가 데이터 모이면 **learned ranker (e.g. GraphPlanner)** 도입 검토. 지금은 cold-start라 rule이 합리.
- 🔹 7 signal은 어떻게 정했나? → behavioral interview 문헌 기반: impact / complexity / ownership / scope / jd_match / red_flag / measurable. **rule-only는 jd_match 1축만 봤음 → multi-signal로 확장**한 게 hybrid 도입의 직접 동기.

### Q4. Planner/Executor 각각의 역할 — `두괄식`
**결론** **Planning은 hybrid (LLM scoring + rule structure), Execution은 LLM, Routing은 code**. 책임 분리로 debuggability / cost / reliability 동시 확보.
**근거+예시**
- **Planner (`plan_builder.py`)**
  - `suggest_scan_candidates_llm` (LLM): 7-signal multi-criteria scoring, **JSON mode + structured output** schema, temperature=0.2 (mild diversity)
  - `enforce_scan_rules` (code): top-2 jd_match + bottom-1 jd_unmatched **slot constraint** 강제 — post-LLM validator
  - `build_scan_plan_hybrid` (orchestrator): Suggester → Validator → rule fallback **graceful degradation chain**, `source` 메타로 observability
  - `build_dive_plan` (code): scan eval의 depth로 argmin=weakness / argmax=strength — **LLM-as-judge 결과를 코드가 집계**
- **Executor (`questioner.py`)**: `generate_scan_question`이 RAG context 결합 generation, `decide_in_topic`이 `dig_deeper / next_topic / end` 결정 (단 depth≥MAX는 코드가 **guard rail로 override**)
- **Evaluator (`evaluation.py`)**: LLM-as-judge 5축 채점 → 서버에서 weighted overall 계산 (LLM 산수 우회) + quality cap post-normalization

- 🔹 depth 점수는 누가 매기나? → LLM-as-judge가 0~100, 서버가 clamp+normalize+quality cap. depth만 dive 선정에 씀(현재). multi-signal weighted ranker가 다음 후보.
- 🔹 약점·강점 둘 다 파는 이유? → 약점=보완 확인, 강점=깊이 검증. 학습용 도구(VoicePrep)라 **약점 보완이 핵심 가치**. 제품 목적에서 직접 도출.
- 🔹 왜 depth만 봄? → hand-crafted heuristic이고 data-driven 검증은 아님. 솔직히 인정. **multi-criteria scoring with learned weights**가 다음 단계.
- 🔹 LLM Suggester 비결정성 어떻게 다루나? → temperature=0.2로 mild만 허용 + Rule Validator로 슬롯 구조 강제 + fallback chain. fully deterministic은 아니지만 **bounded non-determinism**.
- 🔹 7 signal 가중치는? → 현재 LLM이 implicit하게 score로 종합. signal별 explicit weight는 안 줌. 평가 데이터 모이면 weight learning 가능 (RLHF / DPO).
- 🔹 프로젝트가 1개뿐이면? → 같은 프로젝트를 weakness/strength 두 angle로(`plan_builder.py:162`).

### Q5. State/Node/Edge 활용 — `두괄식`
**결론** State 하나(`InterviewState`)에 세션 전체를 담고, 2개의 조건부 엣지로 루프를 만듭니다. **근거** 노드는 state-in/state-out 불변. **예시** `_route_phase`(scan→scan_next, dive→decide_in_topic), `_route_action`(scan_ask/build_dive_plan/dive_ask/end). 이 조건부 엣지가 "주제 내 반복 vs 다음 주제" 분기. **재강조** 상태가 DB에 직렬화돼 HTTP 요청 간 복원됩니다.

- 🔹 State가 커지면 직렬화 비용은? → JSONB로 저장, scan/dive plan은 수 KB 수준이라 무시 가능.
- 🔹 노드 실패 시 복구는? → 각 요청이 독립 그래프 실행이라 실패해도 마지막 영속 state에서 재개. SSE로 error 이벤트.
- 🔹 동시성? 같은 세션 두 답변이 오면? → 세션 상태는 current_idx로 진행, 프론트가 순차 제출하므로 사실상 단일 흐름.

### Q6. 왜 LangChain 아닌 LangGraph — `트레이드오프`
**선택지** LangChain(순차 체인) vs LangGraph(상태 그래프) vs 직접 구현. **기준** ① 조건부 루프 필요 ② 상태 영속화 ③ 트레이싱. **결정** 면접은 "평가→분기→반복"이라 그래프가 자연스럽고, state-in/out 모델이 DB 영속화에 맞아 LangGraph. **한계** LangGraph도 추상화 오버헤드가 있어 단순 체인이면 과함 — 우리는 루프가 본질이라 정당화됨.

- 🔹 직접 상태머신 짜도 되지 않나? → 가능. 하지만 LangSmith 트레이싱(`tracing.py`)이 노드 단위로 공짜로 붙는 게 큼.
- 🔹 LangGraph의 단점은? → 디버깅 시 추상화 레이어 너머를 봐야 함. 조건부 엣지 라우터를 순수 함수로 빼서 테스트 가능하게 함.

---

## 3. RAG / pgvector

### Q7. 이력서 4청크 타입 — `두괄식`
**결론** summary/project/experience/education 4종, skills는 일부러 제외. **근거** 검색 단위의 의미 수준이 다름. **예시** project는 description+achievements 통합 1청크라 "그 프로젝트 어떻게 했나" 질문에 정확히 retrieve. skills 태그("React")는 노이즈만 늘어 제외(`resume_memory.py:18`). **재강조** metadata로 어느 프로젝트인지 역추적 가능.

- 🔹 skills 빼면 기술스택 질문은 어떻게? → 스택은 plan에서 JD 매칭에 쓰고, RAG는 맥락(프로젝트 안의 스택 사용)으로 커버.
- 🔹 청크가 너무 길면 임베딩 품질 떨어지지 않나? → 프로젝트 1개는 보통 임베딩 토큰 한도 내. 초과 시 잘림 — 개선 여지.
- 🔹 chunk_type별 가중치는? → 현재 없음. dive 쿼리가 project/experience를 자연히 더 매칭. 명시적 부스팅은 안 함.

### Q8. 임베딩 모델/차원/청크 — `두괄식`
**결론** text-embedding-3-small, 1536차원, 구조 단위 청킹. **근거** 질문마다 쿼리 임베딩을 만들어 small이 비용·속도 합리적. **예시** 고정 토큰이 아니라 프로젝트/경력 단위로 쪼개 의미 경계가 명확. **재강조** large는 이 용도에 과투자.

- 🔹 3-large 쓰면 정확도 오르지 않나? → 오르지만 비용 5배. 우리 청크는 의미 경계가 뚜렷해 small로도 top-3 충분.
- 🔹 차원 축소(MRL)는? → 미적용. 데이터 규모 작아 1536 그대로도 검색 빠름.
- 🔹 임베딩 갱신 시점? → 이력서 저장 시 BackgroundTask로 청킹+임베딩.

### Q9. HNSW vs IVFFlat — `트레이드오프`
**선택지** IVFFlat vs HNSW. **기준** 데이터 규모·빌드 비용·recall. **결정** 사용자×이력서라 수천~수만 벡터 → IVFFlat `lists=100`, cosine(`<=>`)로 충분(`...resume-embeddings.sql:21`). HNSW는 100만+에서 빛나지만 메모리/빌드 과함. **한계** `lists=100`은 데이터 적을 때 recall 불안 — 규모 커지면 HNSW 전환 지점.

- 🔹 lists=100은 어떻게 정했나? → pgvector 권장식(rows/1000) 근사 + 기본값. 데이터 적어 정밀 튜닝 안 함, 솔직히 개선 여지.
- 🔹 probes 설정은? → 기본. recall 문제 생기면 ivfflat.probes 올려 조정 가능.
- 🔹 인덱스 없이 풀스캔은? → 현 규모(사용자당 수십 벡터)면 풀스캔도 빠름. 인덱스는 사용자 늘 때 대비.

### Q10. 왜 top-3 — `두괄식`
**결론** 이력서는 top-3(정밀도), 프로필은 top-10(포괄성)으로 목적별로 다름. **근거** 이력서 RAG는 plan이 이미 "어느 프로젝트"인지 정해놔 관련 청크 3개면 충분. **예시** 더 넣으면 무관 청크가 프롬프트 오염+토큰 증가. **재강조** top-k는 정밀도냐 포괄성이냐로 갈라 잡음.

- 🔹 top-5와 정량 비교했나? → 정식 A/B는 안 함. 솔직히 휴리스틱 + 프롬프트 토큰 관찰. 개선하면 retrieval 평가셋 만들 것.
- 🔹 프로필은 왜 10? → 강점/약점/패턴 전반 맥락이라 포괄성 우선.
- 🔹 retrieve 결과가 0개면? → SLIM 대신 FALLBACK 프롬프트로 분기(`agent.py`).

---

## 4. 사용자 메모리

### Q11. 메모리 추출/저장 — `두괄식`
**결론** 세션 종료 시 LLM이 대화+평가에서 strengths/weaknesses/patterns를 추출해 4카테고리로 임베딩 저장. **근거+예시** `save_session_insights`(`profile_memory.py:158`), 프롬프트에 "이번 세션 새 발견만, 구체적·기술적으로" 명시. **재강조** 추상적 칭찬이 아니라 "React useReducer는 알지만 실무 적용 약함" 수준.

- 🔹 추출이 틀리면 잘못된 기억이 쌓이지 않나? → upsert 0.85 유사도로 갱신, 또 다음 세션 답변이 반박하면 새 인사이트로 덮임.
- 🔹 사용자가 메모리를 보거나 지울 수 있나? → 현재 내부용. 프로필 context API는 있음. UI 노출은 향후.
- 🔹 context 카테고리는 뭐? → 세션 ID 등 메타. 검색 노이즈라 주입엔 거의 안 씀.

### Q12. 토큰 비용 관리 — `두괄식`
**결론** upsert(유사도 0.85)로 중복 누적을 막고, 주입은 top-10만. **근거** 같은 인사이트가 매 세션 쌓이면 비용 폭발. **예시** 유사도>0.85면 INSERT 아닌 UPDATE(`profile_memory.py:55`), 1000개 있어도 프롬프트엔 쿼리 매칭 10개만. **재강조** 저장은 누적, 주입은 상수.

- 🔹 0.85는 어떻게? → 경험적. 너무 낮으면 다른 인사이트를 덮고, 높으면 중복 누적. 0.85가 균형.
- 🔹 오래된 메모리 만료는? → 현재 없음. updatedAt은 있으니 시간 가중 retrieval은 향후 개선.
- 🔹 카테고리 불균형(약점만 쌓임)은? → 카테고리별 검색이라 균형 유지. 강점 0개면 빈 배열 주입.

### Q13. 다음 세션 주입 — `두괄식`
**결론** 시작 시 이력서+JD로 쿼리 만들어 top-10 retrieve 후 카테고리별 슬롯 주입. **근거+예시** `load_user_profile`(`profile_memory.py:118`)이 strengths/weaknesses/patterns로 정리. **재강조** "지난번 약점"을 면접관이 기억하고 그 주변을 파는 효과. 이 슬롯은 정적 prefix라 캐싱됨.

- 🔹 첫 세션엔 메모리 없는데? → 빈 배열 주입, FALLBACK 프롬프트. 세션 쌓이며 개인화.
- 🔹 이력서를 바꾸면 메모리는? → 프로필은 user 단위라 유지. 이력서 RAG만 resume 단위로 분리.

---

## 5. 채점 시스템

### Q14. LLM 단일 채점 신뢰성 낮은 이유 — `STAR`
**상황** 초기엔 채점을 LLM에 통째로 맡김. **과제** ① 가중합 산술 틀림 ② "몰라요"에 90점(`test_evaluator_normalize.py:25`) ③ 호출마다 점수 출렁. **행동** LLM은 항목 raw 점수만, 집계·가드·키워드는 서버가 강제. **결과** 점수 재현성+공정성 확보, 단답 방어.

- 🔹 그럼 LLM 채점을 왜 쓰나, 전부 규칙으로? → 의미 평가(정확성/깊이)는 규칙 불가. LLM은 의미만, 산술·이상치는 코드.
- 🔹 LLM 점수 자체가 편향이면? → 항목 독립 채점 + 가중치 고정으로 편향 완화. 완벽하진 않음, 인정.
- 🔹 채점 일관성 측정했나? → 정식 측정은 미흡. 가드 테스트(단답 cap)는 있음.

### Q15. 결정적 가중 합산 — `두괄식`
**결론** `_normalize_evaluation`의 3단계: clamp → quality cap → overallScore 서버 재계산. **근거+예시** `overall = sum(scores[k]*w)`, LLM의 overallScore는 버림(`evaluation.py:110`). 가중치 상수: clarity30/accuracy25/practicality25/depth15/completeness5. **재강조** 리포트 집계도 서버값으로 덮어씀.

- 🔹 가중치는 어떻게 정했나? → 기술면접 우선순위(전달력·정확성 우선). 심화는 depth 15→25로 별도.
- 🔹 가중치 근거는 데이터인가 직관인가? → 솔직히 도메인 직관. 사용자 데이터 쌓이면 보정 여지.
- 🔹 항목 간 상관(clarity↔completeness)은? → 독립 채점이라 중복 가능. 가중치로 영향 제한.

### Q16. guardrail 발동 — `두괄식`
**결론** `_quality_cap`이 답변 품질에 계단식 상한, 진입점에선 HTTP 400 1차 차단. **근거+예시** 빈→0, 10자미만→15, 고유문자<0.25→20, 고유토큰비<0.35→25, 고유토큰<5→30(`evaluation.py:36`). cap 시 키워드도 무효화. 백엔드 10자/3토큰 미만 400(`agent_interview.py:41`). **재강조** 음성 노이즈를 평가 전에 거름.

- 🔹 임계값(0.25, 0.35)은? → 반복 답변("제일제일") 샘플로 경험적 설정. 정상 답변 오탐 없게 보수적.
- 🔹 정상인데 짧고 정확한 답이 cap 맞으면? → 10자/토큰 기준이 낮아 실제 답변은 거의 안 걸림. 한국어 단답 케이스는 모니터링.
- 🔹 cap과 LLM 0점이 충돌하면? → min 적용, 둘 중 낮은 쪽.

---

## 6. 비용 최적화

### Q17. Prompt Caching 원리 — `두괄식`
**결론** prefix가 1024토큰↑이고 호출 간 동일하면 OpenAI가 자동 캐시, 적중분 input 단가 50%. **근거** 그래서 prefix 불변 구조화가 전부. **예시** system→cached_context→assistant ACK→variable 순(`llm_client.py:90`), 앞3개 고정. **재강조** 코드 변경 없이 메시지 순서 설계로 절감.

- 🔹 캐시 TTL은? → 보통 수분~시간. 세션이 짧아 세션 내 적중이 핵심.
- 🔹 prefix가 1024 미만이면? → 캐시 안 됨. 그래서 루브릭+RAG를 prefix에 모아 1024 넘김.
- 🔹 Anthropic 캐시와 차이? → Anthropic은 명시적 cache_control 마킹, OpenAI는 자동(prefix 매칭). 우리는 OpenAI 자동.

### Q18. 정적/동적 영역 분리 — `두괄식`
**결론** 정적=루브릭/페르소나/RAG청크/JD/플랜, 동적=phase/idx/대화히스토리. **근거+예시** `build_question_messages`가 stable/variable 반환, SLIM 프롬프트도 앞=prefix, `{conversation_history}`=suffix(`agent.py:68`). **재강조** 커밋 `8be90cf`로 구조 분리.

- 🔹 대화 히스토리를 prefix에 넣으면 더 캐시되지 않나? → 히스토리는 매 턴 변해 prefix에 넣으면 prefix가 깨져 전체 미스. 일부러 suffix.
- 🔹 RAG 청크는 변하는데 왜 정적? → 세션 내내 같은 이력서라 불변. 세션 간엔 바뀌어도 됨.

### Q19. 11% 측정 방법 — `STAR`
**상황** 캐싱 효과를 "체감"이 아닌 숫자로 증명해야 함. **과제** 실제 절감률 측정. **행동** 7턴 세션 시뮬 스크립트(`measure_prompt_cache.py`)로 응답의 `cached_tokens` 집계, 가격표 박아 비용 계산. **결과** hit ratio 27.5%, **11.1% 절감**(turn 4,6 적중) — 마케팅 아닌 토큰 실측.

- 🔹 11%면 작지 않나? → prefix를 2~3k로 키우면 더 큼. 현 prefix가 ~1050이라 시작점.
- 🔹 측정이 1세션이면 일반화 되나? → 한계 인정. 대표 시나리오 1개. 실트래픽 로깅(`LLM_METRICS_FILE`)으로 검증 예정.
- 🔹 캐시 미적중 턴은 왜? → 초반 prefix 워밍업 전 + 히스토리 누적으로 토큰 경계 변동.

### Q20. gpt-4o-mini 선택 — `트레이드오프`
**선택지** 4o-mini vs 4o vs 4.1-mini. **기준** 호출당 비용(면접당 7+회)·한국어/JSON 안정·캐싱 지원. **결정** 4o-mini — 채점 신뢰성은 모델 아닌 서버 가드로 확보하므로 비싼 모델 불필요. **한계** 평가 품질 부족하면 `AGENT_MODEL` 환경변수로 즉시 상향(`config.py:17`).

- 🔹 mini가 한국어 평가를 제대로 하나? → JSON 셰이프는 안정적. 의미 평가는 서버 가드가 이상치 보정.
- 🔹 모델 교체 시 프롬프트 재튜닝은? → 환경변수만 바꾸면 됨. 프롬프트는 모델 중립적으로 작성.

---

## 7. TTFA / TTS

### Q21. TTFA란 — `두괄식`
**결론** Time To First Audio, 질문 텍스트 준비 후 첫 소리까지의 시간. **근거** 음성 면접은 침묵이 길면 몰입이 깨짐. **예시** 전체 완성(total)보다 첫 바이트가 체감 좌우. **재강조** 그래서 total 아닌 TTFA를 핵심 지표로.

- 🔹 total latency는 안 중요한가? → 사용자는 들으면서 답 생각하니 첫 소리가 우선. total은 보조.
- 🔹 TTFA를 어떻게 쟀나? → Q23 참조, 고정 길이 텍스트 3종 측정.

### Q22. TTFA 64% 개선 — `STAR`
**상황** 긴 질문은 첫 소리까지 3.3초씩 걸려 어색. **과제** 병목 제거. **행동** 5군데 버퍼링 발견 → 엔드투엔드 스트리밍(tts `iter_bytes` yield, 백엔드 `httpx.stream` 패스스루, nginx `proxy_buffering off`) + 프론트 MSE 점진 재생. **결과** long 3.32→1.18s, **64% 단축**.

- 🔹 5군데가 정확히 어디? → ①tts join ②backend res.content ③Response 버퍼 ④프론트 blob ⑤인코딩(`speech.py`, `tts/main.py`).
- 🔹 스트리밍 시 오디오 깨짐은? → mp3 프레임 단위 yield, MSE가 SourceBuffer로 디코딩. 미지원 브라우저는 blob 폴백.
- 🔹 nginx buffering 끄면 다른 응답 영향은? → 해당 location만 적용, SSE도 같은 설정 필요.

### Q23. 64%는 p50/p95/평균? — `두괄식` (정직하게)
**결론** 분포 기반 p50/p95가 아니라 **고정 길이 3종 측정의 long 케이스 단일 개선율**입니다. **근거** short21%/medium43%/long64%. **예시** 개선폭이 길이 비례하는 건 기존이 "전체 완성 대기"였고 스트리밍 후 길이 무관 ~1.2s로 평탄해져서. **재강조** 64%는 최선(long), 평균적으론 더 낮다고 정직히 말합니다.

- 🔹 그럼 대표값으로 64% 내세우는 건 과장 아닌가? → 맞습니다, 그래서 "long 기준"을 항상 병기. 평균은 ~40%대.
- 🔹 p95를 안 잰 이유? → 개인 프로젝트라 트래픽 부하 분포가 없었음. 부하 측정 하네스가 향후 과제(Q27).
- 🔹 네트워크 변동은 통제했나? → 동일 로컬 환경 반복 측정. 외부 변동은 미통제, 한계.

### Q24. 폴백 발동 조건 — `두괄식`
**결론** OpenAI TTS 호출이 예외나면 edge-tts(ko-KR-HyunsuNeural)로 폴백. **근거+예시** try/except로 감싸 실패 시 StreamingResponse 전환(`speech.py:33`). **재강조** 쿼터 초과/네트워크 오류에도 면접 무중단. 단 페르소나 톤은 edge-tts엔 미적용.

- 🔹 부분 실패(스트림 중 끊김)는? → 첫 send 실패만 폴백. 스트림 중 끊김은 재시도 미구현, 개선 여지.
- 🔹 폴백 품질 차이를 사용자가 아나? → 음색 다름. 명시 알림은 없음.
- 🔹 왜 edge-tts? → 무료·한국어 음성 양호·Python 네이티브.

---

## 8. SSE / 인프라

### Q25. SSE vs WebSocket — `트레이드오프`
**선택지** SSE vs WebSocket vs 폴링. **기준** 통신 방향성·인프라 호환·복잡도. **결정** 면접은 단방향 서버→클라(status→question), 입력은 다음 POST라 SSE. HTTP 표준이라 nginx/Cloudflare 호환 좋고 EventSource 자동 재연결. **한계** 진짜 양방향(실시간 협업)엔 부적합 — 우리 패턴엔 과한 WebSocket 불필요.

- 🔹 답변 제출도 스트림이면 WebSocket이 낫지 않나? → 답변은 단발 POST, 응답만 스트림. 양방향 상시연결 불필요.
- 🔹 SSE 연결 끊기면? → EventSource 자동 재연결. 단 상태는 DB 영속이라 재요청으로 복원.
- 🔹 nginx 설정 주의점? → `proxy_buffering off`, `read_timeout 300s` 안 하면 SSE가 버퍼링돼 끊김.
- 🔹 동시 연결 수 한계? → 단일 PC라 제한적. 트래픽 늘면 인프라 이전 필요.

---

## 9. 회고

### Q26. 가장 어려웠던 부분 — `STAR`
**상황** 채점·질문흐름을 LLM에 맡김. **과제** 점수 출렁, 산만한 질문, 단답 고득점. **행동** "LLM을 어디까지 믿고 어디부터 코드로 제약할지" 경계를 그음 — 채점은 항목만 LLM+서버 가드, 질문은 계획 코드+슬롯 LLM, 음성 노이즈는 평가 전 차단. **결과** 재현성·공정성 확보. 가장 많이 배운 건 "LLM은 강력하지만 결정론적 보증이 필요한 곳엔 코드가 받쳐야 한다".

- 🔹 그 경계를 어떻게 판단? → "재현성/공정성이 필요한가"가 기준. 필요하면 코드, 아니면 LLM.
- 🔹 다른 어려움은? → TTS 스트리밍 5단 버퍼링 추적, JWE 백엔드 복호화 키 유도.
- 🔹 그 교훈을 다음에 어떻게 적용? → AI 기능 설계 시 "LLM 출력 검증 레이어"를 먼저 설계.

### Q27. 다시 만든다면 — `두괄식`
**결론** 측정·인덱스·캐싱 3가지를 처음부터 다르게. **근거+예시** ① TTFA를 p50/p95 분포로(지금 3샘플 대표값) ② pgvector 인덱스 자동 전환(IVFFlat→HNSW) ③ 프롬프트를 처음부터 stable/variable로(나중 리팩터 `8be90cf` 컸음). **재강조** 공통 교훈은 "측정 가능성·확장성을 설계 초기에".

- 🔹 가장 우선순위는? → 측정. 11%·64%를 더 신뢰성 있게 말하려면 측정 하네스가 먼저.
- 🔹 기술 스택 자체를 바꿀 건? → 핵심(LangGraph/pgvector/FastAPI)은 유지. 설계 순서만 개선.
- 🔹 후회되는 결정은? → 프롬프트를 캐싱 고려 없이 짜서 나중에 쪼갠 것. 초기 설계 부재.
