# 버그 #1 — 모바일 답변 중복 입력

**발견일**: 2026-04-13
**세션 실측**: `agent_interview_sessions.id = f04d1416` (completed)

## 증상

모바일(Android Chrome 146) 면접 중 답변 제출 시 같은 문구가 여러 번 반복되어 저장됨.

DB 덤프:
```
[1] user_answer len=209:
'제일제일제일제일제일제일 어려웠던제일 어려웠던 프로젝트는제일 어려웠던 프로젝트는제일
어려웠던 프로젝트는제일 어려웠던 프로젝트는 이제이게이게이게 왜이게 왜 이렇게이게 왜
이렇게이게 왜 이렇게이게 왜 이렇게 ...'
```

의미 있는 발화는 "제일 어려웠던 프로젝트는 ... 이게 왜 이렇게 ..." 정도인데 6배 이상 중복.

## 근본 원인

1. **Web Speech API Android 특성**: `SpeechRecognition`이 동일 final result를 여러 번 `onresult` 이벤트로 발송. 데스크톱 Chrome은 드묾, Android Chrome은 흔함.
2. **`useSpeechRecognition.onresult`**: `finalTranscript` 받으면 `setTranscript((prev) => prev + finalTranscript)` — 중복 검증 없이 append
3. **`onend` 자동 재시작**: `_shouldListen` 이 true면 `recognition.start()` 재호출. 재시작 시 새 세션에서 이전과 동일한 interim/final이 다시 들어오는 경우가 있음
4. **`normalizeTranscript`**: 현재 `STUTTER_PATTERN = /(\S+)\s+\1/g` 만 있어 "저 저는" 같은 **단일 단어 연속 중복**만 제거. "제일 어려웠던제일 어려웠던" 같은 **다중 단어 phrase 반복**은 그대로 통과

## 수정

### A. `useSpeechRecognition` 훅: final transcript append 시 overlap 제거

`setTranscript((prev) => prev + finalTranscript)` 대신 `prev`의 꼬리와 `finalTranscript`의 머리가 겹치면 중복 부분 skip.

### B. `normalizeTranscript`: N-gram phrase 반복 collapse 추가

연속되는 1~5단어 phrase가 2번 이상 반복되면 1회로 줄임.
예:
- "제일 어려웠던 제일 어려웠던" → "제일 어려웠던"
- "이게 왜 이렇게 이게 왜 이렇게 이게 왜 이렇게" → "이게 왜 이렇게"
- "A B C A B C A B" → "A B C"

### C. onresult에서 동일 이벤트 중복 방지 (방어막)

`event.results[i].isFinal` 결과의 text+timestamp를 최근 이벤트로 기억, 동일하면 skip.

## 영향 범위
- `frontend/src/lib/transcript.ts` — `normalizeTranscript` 강화
- `frontend/src/hooks/useSpeechRecognition.ts` — final append overlap 제거
- 다른 소비자(journal, nightly-study)에도 동시 개선 효과

## 검증
- 유닛 테스트 불가능한 환경 — 로컬 모바일로 다시 녹음해 확인
- 기존 세션(f04d1416)의 raw 답변을 normalizeTranscript에 넣어 결과 확인
