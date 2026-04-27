# 면접관 아바타 + 속마음 UX 설계

날짜: 2026-04-27
대상: AI 코치 면접 (`/agent-interview/session/...`) — `AgentInterviewPanel`

## 목표
- 면접관에 시각적 존재감(얼굴 + 표정)을 부여해 몰입감/재미를 높인다.
- 면접관의 "속마음"을 노출해 답변에 대한 메타 피드백을 즉각 전달한다.
- 평가 대기 시간(`evaluating` phase)을 스피너에서 "면접관이 곰곰 생각하는 컷씬"으로 전환한다.

## 컨셉
역전재판/페르소나 풍의 2D 캐릭터 + 표정 변화 + 속마음 풍선. 진중한 면접 시뮬레이터가 아니라 **부담 완화 + 재미**가 핵심 톤.

## 결정 요약
| 항목 | 결정 |
|------|------|
| 톤 | 역전재판/페르소나 스타일 (게임형 캐릭터) |
| 속마음 트리거 시점 | **답변 제출 직후, `evaluating` ~ 다음 질문 직전까지** |
| 캐릭터 | **고정 스프라이트 1명 × 표정 6종** (MVP) |
| 속마음 텍스트 소스 | **기존 evaluation LLM 출력에 `innerThought` 필드 추가** (별도 LLM 호출 없음) |
| 레이아웃 | **한 스테이지 프레임 안에 좌측 캐릭터 + 우측 속마음 풍선**, 질문은 아래 별도 파란 박스 |

## 컴포넌트 분해

### 1. 캐릭터 에셋 (`frontend/public/interviewer/`)
- 면접관 1명, PNG 또는 SVG, 6개 표정:
  - `neutral.png` — 기본/질문 던지는 중
  - `listening.png` — 사용자 답변 중 (녹음 중)
  - `thinking.png` — 평가 중 (🤔 톤)
  - `impressed.png` — score ≥ 80
  - `skeptical.png` — 60 ≤ score < 80 또는 의심성 속마음
  - `disappointed.png` — score < 60
- 단일 사이즈, 정사각/세로 4:5. 동일 캐릭터·동일 의상·표정만 차이.
- 작업 방식: AI 일러스트(SDXL/Midjourney)로 6장 일괄 생성 후 사람 손으로 톤 보정. 한 번 만들면 끝.

### 2. `InterviewerStage` 컴포넌트 (신규)
파일: `frontend/src/components/agent-interview/interviewer-stage.tsx`

Props:
```ts
{
  expression: 'neutral' | 'listening' | 'thinking' | 'impressed' | 'skeptical' | 'disappointed';
  innerThought: string | null;  // null이면 풍선 숨김
}
```

레이아웃:
- 외부 컨테이너: rounded-2xl, gradient 배경 (캐릭터 무대 느낌), `aspect-[5/3]` 정도
- 좌측 ~45% — 표정 이미지 (`<Image>` priority, 6장 모두 preload)
- 우측 ~55% — 속마음 풍선 (`AnimatePresence` 페이드+살짝 위로 이동)
- 풍선: 노란 배경(amber-100) + 점선 테두리(amber-600 dashed) + 이탤릭 + 좌측에 💭 아이콘 + 풍선 꼬리(::after) 좌측 향함
- `innerThought === null` 일 때 풍선은 unmount (아바타만 단독)

### 3. `AgentInterviewPanel` 통합
`frontend/src/components/agent-interview/agent-interview-panel.tsx`:

상단 currentQuestion Card 위에 `<InterviewerStage>` 삽입.

표정 매핑 로직 (panel 내부에서 phase + 최근 evaluation으로 계산):
```ts
function deriveExpression(phase, lastEvaluation, isListening): Expression {
  if (phase === 'evaluating' || phase === 'generating_followup') return 'thinking';
  if (isListening) return 'listening';
  if (lastEvaluation && phase === 'waiting_answer') {
    const s = lastEvaluation.overallScore;
    if (s >= 80) return 'impressed';
    if (s >= 60) return 'skeptical';
    return 'disappointed';
  }
  return 'neutral';
}
```

속마음 매핑:
- `phase === 'evaluating'` 동안: 직전 답변 평가가 stream으로 도착하기 전엔 정적 placeholder (`"흠... 잠깐 보자"`). 평가 도착 후 `innerThought` 표시.
- `phase === 'waiting_answer'` 직후 (질문 도착, 답변 시작 전): `innerThought = lastEvaluation?.innerThought` 유지 (다음 질문이 시작될 때까지 풍선 그대로).
- `isListening` 진입 시 풍선 페이드아웃 → null. 답변 중엔 표정만 listening.
- `phase === 'generating_question'` 등 첫 질문 전: null.

### 4. 백엔드 — evaluation에 `innerThought` 필드 추가

`backend/app/prompts/evaluation.py`의 `EVALUATOR_PROMPT` (그리고 fitting agent 평가 프롬프트):

JSON 스키마에 한 줄 추가:
```
"innerThought": "면접관 1인칭 속마음 한 줄. 자연스러운 반말, 30~50자, 캐릭터성 있는 한국어. 점수에 맞는 톤. 예: '오, 트레이드오프는 좋은데 수치가 빠졌네...', '음... 추상적이군', '흥미롭군. 더 파볼까?'"
```

`backend/app/agent/interview/evaluation.py::_normalize_evaluation`:
- `innerThought` 누락/공백 시 점수 기반 fallback (`{>=80: '오, 좋은데?', 60~80: '음... 애매하네', <60: '아쉽다...'}`).
- 길이 80자 trim.

`AgentInterviewMessage.evaluation` JSON에 `innerThought` 그대로 영속화. 별도 컬럼 불필요.

SSE `evaluation` event payload에 `innerThought` 포함.

### 5. 데이터 흐름
```
사용자 답변 제출
  → SSE phase=evaluating (panel: expression='thinking', innerThought=placeholder)
  → SSE evaluation event (innerThought 포함) → panel: innerThought 갱신, expression= score 매핑
  → SSE phase=generating_question → 표정 유지, 속마음 유지 (다음 질문 도착까지)
  → SSE question 도착 → expression='neutral', innerThought=null
  → TTS 재생
  → 마이크 listening 시작 → expression='listening'
  → 답변 제출 → 위 사이클 반복
```

## 에러/엣지
- 이미지 로드 실패: 기본 ☐ placeholder + 텍스트 fallback. 콘솔 경고만.
- `innerThought` 누락: fallback 문구로 대체 (위 normalize 단계에서 보장).
- 첫 질문이라 evaluation이 아직 없을 때: 풍선 숨김, expression='neutral'.
- textMode (admin 텍스트 모드): 스테이지는 그대로 노출 (E2E 시각 회귀 베이스라인 갱신 필요).

## 변경 파일 목록
- 신규: `frontend/public/interviewer/{neutral,listening,thinking,impressed,skeptical,disappointed}.png`
- 신규: `frontend/src/components/agent-interview/interviewer-stage.tsx`
- 수정: `frontend/src/components/agent-interview/agent-interview-panel.tsx` — Stage 삽입 + expression/thought 파생
- 수정: `frontend/src/hooks/useAgentInterview.ts` (또는 SSE 처리 부분) — `innerThought`를 evaluation 페이로드에서 보존
- 수정: `backend/app/prompts/evaluation.py` — `innerThought` 필드 스펙 추가
- 수정: `backend/app/agent/interview/evaluation.py` — normalize에 fallback + trim
- 수정: `tests/e2e/specs/agent-interview.spec.ts-snapshots/*` — 시각 베이스라인 (사용자 승인 후)

## 비포함 (out of scope)
- 면접관 페르소나 풀(여러 명) — 후속 단계
- 답변 중 실시간 표정 변화 — 후속 단계
- TTS 보이스 캐릭터별 분리 — 후속 단계
- 학습 코치(Learning Coach)에 동일 적용 — 별도 스펙

## 측정 (voiceprep-feature 메트릭)
Before/After:
- LLM 토큰 평균 / 면접 (innerThought 추가로 ~5~15 token 증가 예상)
- evaluation 응답 지연 (필드 1개 추가는 영향 거의 없을 것)
- 번들 크기 (이미지 6장 + 컴포넌트)
- TS 에러 0 유지
- 면접 1회 완료까지 사용자 체감(정성) — 출시 후 사용자 피드백
