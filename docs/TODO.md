# TODO

## 🔥 최우선 — 평가 시스템 버그 (2026-04-13 분석 완료)

### 핵심 발견 (실 DB 덤프 + 코드/프롬프트 분석)

**증상**:
1. **모든 답변의 `overallScore`가 70점 고정**으로 출력
2. 역량별 점수도 단조로움 (예: 4개 답변 연속 `clarity:15, accuracy:20, practicality:20, depth:10, completeness:5` 패턴)
3. 마지막 케이스에서 `scores` 합이 60인데 `overallScore: 70` — **합산과 mismatch**
4. **역량별 평균점수 표시가 이상함** (대시보드/리포트)
   - 1차 원인: 답변별 scores 단조로움 → 평균도 단조롭게 나옴
   - 2차 원인 의심: 프론트가 정규화 없이 raw 숫자 표시. clarity(15/30=50%)와 completeness(5/5=100%)를 같은 스케일로 비교 → 시각적으로 무의미
   - 확인 위치: `frontend/src/components/agent-interview/` 리포트 컴포넌트, `backend/app/services/analytics.py`(역량별 집계 있는지)
5. 리포트의 "개선점(improvements)"이 비어있음

**근본 원인 (`backend/app/prompts/agent.py:173-194` EVALUATOR_PROMPT)**:
```
- clarity (전달력, 30%): ...
- accuracy (기술 정확성, 25%): ...
- practicality (실무 적용력, 25%): ...
- depth (이해 깊이, 15%): ...
- completeness (완성도, 5%): ...
```
- LLM이 **가중치(30%, 25%...)를 각 카테고리의 만점**으로 해석함
  - clarity 만점=30 → ~50% 수준 매김 → 15점
  - accuracy 만점=25 → ~80% → 20점
  - practicality 만점=25 → ~80% → 20점
  - depth 만점=15 → ~67% → 10점
  - completeness 만점=5 → 100% → 5점
  - 합 = **70** (대부분 답변에서 일관)
- `overallScore`는 LLM이 **별도로 매김** (scores와 무관) → 항상 70 박는 패턴
- 코드(`evaluator_agent.evaluate_answer`)에는 합산/검증 로직 **없음** — LLM 출력 그대로 사용

**개선점(improvements) 비어있는 원인**:
- DB 실측: 모든 세션이 `status='in_progress'`, `reportData IS NULL`. completed 0건
- 즉 `improvements` 필드는 `REPORT_PROMPT`(line 196-215)에 정의되어 있고 제대로 작동할 가능성 있음
- 사용자가 면접을 끝까지 안 가고 도중에 멈췄거나, end 핸들러가 호출 안 되는 케이스
- **확인 필요**: 면접 종료 흐름(7문제 도달 or 명시적 end 버튼) 이후 `agent_interview.py` end 핸들러 → `nodes.update_profile + nodes.generate_report` 호출 흐름이 실제로 도는지

### 수정 후보

**A. 프롬프트 명확화 (가장 간단)**
```
EVALUATOR_PROMPT:
- 각 카테고리는 0~100 척도로 매기세요.
- overallScore = clarity*0.30 + accuracy*0.25 + practicality*0.25 + depth*0.15 + completeness*0.05
```

**B. 코드에서 가중평균 강제 (가장 안전)**
- `evaluate_answer` 후처리에서 `overallScore = sum(scores[k] * weights[k])` 계산해 덮어쓰기
- LLM이 가중평균 못 해도 코드가 보장
- 잘못된 score 키 누락 시 fallback (50 정도)

**C. A + B 결합 (권장)**
- 프롬프트는 명확하게 — LLM이 의미 있는 0~100 점수 매기게
- 코드가 weighted average 계산 — 일관성 보장
- 둘 다 적용하면 70점 단조성 해소 + 정합성 보장

**D. report 생성 보장 검증**
- 면접 종료 시 SSE 이벤트 시퀀스 로그 확인
- end 핸들러 흐름 디버그 (`update_profile` → `generate_report` 호출 순서 + `session.report_data` 저장)
- 프론트 리포트 페이지가 reportData를 어떻게 표시하는지 (필드명 일치성)

### 영향 범위

- `backend/app/prompts/agent.py` (EVALUATOR_PROMPT line 158-194, REPORT_PROMPT line 196-215)
- `backend/app/agent/evaluator_agent.py` (post-processing — 합산/검증 코드 추가 위치)
- `backend/app/routers/agent_interview.py` (end 핸들러 흐름 — `/api/agent-interview/{session_id}/end`)
- `backend/app/agent/nodes.py` (`update_profile` + `generate_report` 호출 순서)
- 프론트엔드 리포트 표시 컴포넌트 (`frontend/src/components/agent-interview/...`)
- `backend/app/services/analytics.py` (대시보드 역량별 집계 — 정규화 로직 점검)

### 회귀 가능성 평가

- 이번 세션(`feat/resume-rag`)에서 evaluator_agent / EVALUATOR_PROMPT는 **건드리지 않음** → 신규 회귀 아님
- main 브랜치에서도 동일 현상일 가능성 높음 (기존 버그)
- `git log -- backend/app/prompts/agent.py backend/app/agent/evaluator_agent.py` 로 마지막 변경 시점 확인하여 도입 시점 추적 가능

### 우선 검증 명령

```bash
# completed 세션의 reportData 덤프
docker exec voice_training-backend-1 python -c "
import asyncio, json
from sqlalchemy import text
from app.database import async_session
async def main():
    async with async_session() as db:
        r = await db.execute(text(\"SELECT id, \\\"reportData\\\", \\\"overallScore\\\" FROM agent_interview_sessions WHERE status='completed' ORDER BY \\\"createdAt\\\" DESC LIMIT 3\"))
        for row in r.fetchall():
            print(row.id[:8], row.overallScore, json.dumps(row.reportData, ensure_ascii=False)[:300] if row.reportData else 'NULL')
asyncio.run(main())
"

# 답변별 scores 분포
docker exec voice_training-backend-1 python -c "
import asyncio
from sqlalchemy import text
from app.database import async_session
async def main():
    async with async_session() as db:
        r = await db.execute(text(\"SELECT evaluation->'scores' AS s, evaluation->>'overallScore' AS o FROM agent_interview_messages WHERE evaluation IS NOT NULL ORDER BY \\\"createdAt\\\" DESC LIMIT 20\"))
        for row in r.fetchall():
            print(row.s, '→ overallScore:', row.o)
asyncio.run(main())
"
```

---

## UX 개선 (면접 연습)

### 면접 중 침묵 허용 늘리기 (답변 서두름 완화)
- **현황 (2026-04-13 테스트 피드백)**: 면접 진행 중 답변 시간이 너무 짧게 강제되거나 침묵 감지가 과민해서 **"급해서 연습이 안 됨"**.
- **목표**: 사용자가 여유 있게 생각하고 답변할 수 있게 침묵/대기 정책을 완화.
- **조사 필요**:
  - `frontend/src/hooks/useSpeechAnalytics.ts` — `silenceSec` / `silenceRatio` 임계치가 UI에서 어떻게 압박으로 작용하는지
  - `frontend/src/hooks/useAudioRecorder.ts` — 자동 종료 타이머 존재 여부
  - 프론트엔드 UI에서 "답변 대기" 관련 카운트다운/시각적 압박 요소
  - SSE 타임아웃 / 백엔드 세션 유효시간
- **후보 변경**:
  - 자동 종료 타이머 있으면 느슨하게 (예: 무음 10s → 30s) or 완전 제거
  - "다음 질문으로" 버튼을 명시적으로 유저가 누르게
  - 실시간 필러워드/속도 피드백은 유지하되 시각적 카운트다운은 제거

### 꼬리질문 중복/애매함 개선
- **현황 (2026-04-13 테스트 피드백)**: 꼬리질문이 **너무 자주 나오고 + 비슷한 주제 반복 + 질문 자체가 애매**("~같은 거 물어봐" 식 두루뭉술한 표현).
- **관련 코드**: `backend/app/agent/interviewer_agent.py` `generate_followup` + `backend/app/prompts/agent.py` `INTERVIEWER_FOLLOWUP_PROMPT` + `backend/app/agent/nodes.py` `decide_next` 분기 조건.
- **조사 필요**:
  - `decide_next` 에서 follow_up 선택 조건 (depth < 80 기준이 너무 느슨한지)
  - depth 점수 분포 실측 (위 평가 시스템 수정 후 다시 측정)
  - 꼬리질문 생성 프롬프트에 "이전 질문들과 주제 겹치지 마라" 제약 부재
- **후보 변경**:
  - 꼬리질문 최대 횟수를 현재 2 → 1로 줄이기 (or 연속 follow_up 허용 안 함)
  - `generate_followup` 프롬프트에 직전 질문들 나열 + "주제·형식 중복 금지" 명시
  - 모호한 질문 방지 — `"구체적으로 설명해주세요"` 같은 두루뭉술 표현을 프롬프트 규칙으로 차단, **하나의 구체 사실/결정을 찍어서 묻도록** 강제
  - depth 임계치 상향 (예: 80 → 70) — 어지간하면 next_question으로 넘어가게
- **선후 관계**: 평가 시스템 70점 고정 버그 수정 후 depth 점수가 의미 있게 변동해야 이 작업의 임계치 설정이 의미 있음

---

## 기능 추가 (향후)

### 채용공고 등록 시 자동 기업 심층 정보 수집

- **현황**: 채용공고 등록 → LLM이 `rawText` 파싱 + 기본 기업 분석(`company_analysis`). Tavily 웹 검색 기반 "심층 분석"은 이전 버튼 방식으로 존재했으나 **제거됨** (별도 버튼/API 삭제, 2026-04-13).
- **목표**: 채용공고 등록 플로우에 **회사 검색 + 심층 정보 수집**을 자동 통합.
  - Tavily 또는 다른 검색 API 사용
  - 면접 후기 / 기출 트렌드 / 최근 뉴스 / 제품 / 문화 정보 수집 후 구조화
  - `company_analysis` 자체를 심층 수준으로 격상 (지금의 `deepResearch` 서브필드 방식이 아니라 통합)
- **관련 (제거된) 코드 참고**: git history `before 2026-04-13` — `do_deep_research` / `_search_company_info` / `deep_company_research` / `DEEP_COMPANY_ANALYSIS_PROMPT` / `POST /api/job-posting/{id}/research`. 되살릴 때 참고.
- **크레딧**: 유료화 이후에 과금 대상으로 편입 예정. 현재는 무료.
- **Fit Analysis 연동 가능성**: 수집된 `pastQuestionTrends` / `suggestedQuestions`를 `run_fit_analysis` 프롬프트에 함께 주입 → focus_topics가 실제 기출 기반으로 강화.
