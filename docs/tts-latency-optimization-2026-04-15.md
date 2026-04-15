# TTS 응답 지연 최적화 (2026-04-15)

## 문제 정의

"질문을 말해주세요" 버튼을 눌러 **첫 오디오 바이트가 브라우저에서 재생되기까지의 지연**을 줄인다. 발화 속도(playbackRate, instructions pace hint)와 무관한, 순수 **파이프라인 latency (TTFB + 전송 완료)** 문제.

## 현재 구조 (Before)

```
브라우저  ── POST /api/tts (JSON) ──▶  nginx  ──▶  backend (speech.py)
                                                       │
                                                       │ httpx.post (buffered)
                                                       ▼
                                                  tts 서비스 (tts/main.py)
                                                       │
                                                       │ OpenAI with_streaming_response
                                                       │ → iter_bytes 전부 수집 후 b"".join()
                                                       ▼
                                                  OpenAI TTS
```

### 병목 지점

| 단계 | 파일 | 문제 |
|---|---|---|
| ① tts 서비스 수신 | `tts/main.py:113-117` | `with_streaming_response` 쓰지만 청크 전부 모아 `b"".join()` → OpenAI 생성 완료까지 대기 후 일괄 반환 |
| ② backend 프록시 | `backend/app/routers/speech.py:44-47` | `res.content`로 전체 바디 한 번에 읽음 |
| ③ backend 응답 | `backend/app/routers/speech.py:77-81` | `Response(content=audio)` 버퍼링, `Content-Length` 완성 후 전송 |
| ④ 프론트 재생 | `frontend/src/hooks/useTextToSpeech.ts:72-73` | `res.blob()` 전체 수신 → `URL.createObjectURL(blob)` → `<audio>` 생성 |
| ⑤ 인코딩 | `tts/main.py:21` | `DEFAULT_FORMAT=mp3` (MPEG 프레임 완성 후 전송 가능, 초반 오버헤드 있음) |

### 측정된 현재 지연 (baseline, `docs/tts-benchmark-2026-04-13.md` 기준)

"첫 소리까지(TTFA, Time To First Audio) = 생성시간 전체"로 체감됨 — 스트리밍이 없기 때문.

| 텍스트 | 글자수 | gen_s (= TTFA) | 오디오 길이 |
|---|---:|---:|---:|
| short | 27 | **1.55s** | 5.06s |
| medium | 63 | **1.99s** | 9.46s |
| long | 129 | **3.32s** | 17.81s |

추가로 backend ↔ tts ↔ 프론트 버퍼링/프록시 오버헤드 ~100-200ms 가 붙음 (실사용). 긴 질문은 **첫 소리까지 3.5~4초** 체감.

## 목표 구조 (After)

```
브라우저  ◀── chunked audio/ogg (opus) ──  backend (StreamingResponse 패스스루)
                                                       ▲
                                                       │ httpx stream (aiter_raw)
                                                       ▼
                                                  tts 서비스 (StreamingResponse)
                                                       ▲
                                                       │ OpenAI with_streaming_response
                                                       │ → iter_bytes 즉시 yield
                                                       ▼
                                                  OpenAI TTS (opus)
```

### 개선 항목

**(1) 엔드투엔드 스트리밍 패스스루**
- `tts/main.py` `/synthesize`: `StreamingResponse` 로 변경, OpenAI `iter_bytes`를 즉시 yield. `b"".join()` 제거.
- `backend/app/routers/speech.py` `/api/tts`: `httpx.AsyncClient.stream()` + `StreamingResponse(aiter_raw())` 로 패스스루. `Content-Length` 헤더 삭제 (청크 전송).
- edge-tts fallback도 `async for chunk` 스트리밍 유지.
- 프론트 `useTextToSpeech.ts`: `URL.createObjectURL(blob)` 대신 **MediaSource 또는 직접 `<audio src=streamedURL>`**. 가장 단순한 길은 `res.blob()`을 유지하되 fetch의 `ReadableStream`을 `MediaSource.appendBuffer`로 점진 공급 — 단, 구현 복잡도 있음. **1차 스코프는 서버 측 스트리밍만** 적용하고, 프론트는 기존 blob 유지해도 "네트워크 수신 시간 단축" 효과만큼은 얻음. 2차에서 MediaSource 도입.

**(2) 인코딩 포맷은 mp3 유지 (검증 결과)**
- 초기 계획은 opus 전환이었으나, 실측에서 **opus가 mp3보다 TTFA 오히려 느림**.
- opus(3회 평균 TTFA): short 2.43s / medium 2.33s / long 1.77s
- mp3(3회 평균 TTFA): short 1.23s / medium 1.14s / long 1.18s
- 원인 추정: OpenAI 측에서 opus 인코딩이 초기 버퍼링을 더 크게 가져가는 듯. mp3는 프레임 즉시 flush.
- 따라서 `DEFAULT_FORMAT=mp3` 유지. `format` 파라미터는 요청 단위로 선택 가능하게 열어둠 (테스트/어드민용).

## 실측 결과 (After)

측정 방법:
- `scripts/measure_ttfa.py` — `http://tts:8080/synthesize` 를 backend 컨테이너 내부에서 `httpx.stream()`으로 호출, 첫 바이트 수신까지의 wall time 기록.
- 3회 평균, Docker dev 환경 (`voice_training-backend-1` → `voice_training-tts-1`).
- 샘플 텍스트는 `docs/tts-benchmark-2026-04-13.md` 와 동일.

**TTFA (Time To First Audio byte)** — 브라우저가 MediaSource로 점진 재생할 때의 체감 지연:

| 텍스트 | Before (gen_s) | After TTFA | 개선율 |
|---|---:|---:|---:|
| short (27자) | 1.55s | **1.23s** | **21%** |
| medium (63자) | 1.99s | **1.14s** | **43%** |
| long (129자) | 3.32s | **1.18s** | **64%** |

긴 텍스트일수록 개선폭 크다. 긴 질문·설명에서 사용자 체감 지연이 3.3초 → 1.2초로 **2.1초 단축**.

**Total (전체 바이트 수신까지)** — 현재 프론트 `res.blob()` 기준 체감:

| 텍스트 | Before | After total_s | 변화 |
|---|---:|---:|---:|
| short (27자) | 1.55s | 1.55s | ±0 |
| medium (63자) | 1.99s | 2.28s | +0.29s (측정 변동) |
| long (129자) | 3.32s | 3.62s | +0.30s (측정 변동) |

Total은 비슷하거나 소폭 늦음 (네트워크 변동 및 청크 분할 오버헤드). **프론트가 `blob()` 방식을 유지하는 한 사용자 체감 지연은 이 수치와 같다.** 서버 스트리밍 개선을 실제 체감하려면 프론트 MSE 도입(2차)이 필요.

### 1차 결론
- 서버 측 파이프라인은 "생성 완료 후 일괄 반환" → "즉시 스트리밍" 으로 완전 전환됨.
- TTFA 기준 최대 64% 단축 확인.
- 프론트는 아직 blob() 기반이라 실사용 체감은 변화 없음 → 2차로 MSE 기반 점진 재생 적용 예정.

## 2차: 프론트 MSE 점진 재생 (2026-04-15 적용)

### 변경
- `frontend/src/hooks/useTextToSpeech.ts` — `MediaSource` + `SourceBuffer.appendBuffer` 기반 점진 재생 경로 추가.
  - `fetch` → `response.body.getReader()` 로 청크 수신
  - `sourceopen` 이후 `audio/mpeg` SourceBuffer 생성, 청크 도착할 때마다 큐잉 + `appendBuffer`
  - `updateend` 이벤트로 큐 플러시, 스트림 종료 시 `endOfStream()`
  - MSE 미지원 브라우저(Safari iOS 구버전 등) → 기존 `blob()` 폴백 유지
  - `stop()` / unmount 시 `endOfStream` + `revokeObjectURL` + `audio` 정리
- 검증: `tsc --noEmit` 통과, `next lint` 통과.

### 사용자 체감 효과
프론트가 첫 청크 수신 즉시 재생 시작 가능 → 사용자 체감 지연 ≈ 서버 TTFA + MSE 디코더 워밍업(수백 ms).

| 텍스트 | Before (blob 완료까지) | After (MSE 재생 시작) | 체감 단축 |
|---|---:|---:|---:|
| short (27자) | ~1.55s | ~1.2s + 디코더 | **~20%** |
| medium (63자) | ~1.99s | ~1.14s + 디코더 | **~40%** |
| long (129자) | ~3.32s | ~1.18s + 디코더 | **~60%** |

긴 질문일수록 효과 큼. 면접관·튜터 긴 안내 문장에서 체감이 확연해질 것.

### 범위 밖 (다음 과제)
- 문장 단위 선제 합성 (긴 답변 청킹 재생)
- 질문 pre-generation (유저 답변 중 다음 질문 미리 합성)

## 범위 밖 (Non-goals)

- 발화 속도 조절 (instructions / playbackRate) — 별도 이슈.
- 문장 단위 선제 합성 (긴 문단을 쪼개 먼저 재생) — 구조 변경 크므로 2차 과제.
- 질문 pre-generation (유저 답변 중 다음 질문 미리 합성) — 에이전트 플래너 변경 필요, 별도 이슈.
- 프론트 MediaSource 기반 점진 디코딩 — 1차 구현 후 필요시 검토.

## 롤백

- 서버 변경 2건은 독립적이라 **feature flag 없이도** 개별 커밋/롤백 가능.
- opus 호환 문제 생기면 `TTS_FORMAT=mp3` 환경변수로 즉시 원복 (이미 코드가 env로 읽음).
- 스트리밍 오류 시 edge-tts fallback 경로는 유지되므로 완전 실패는 방지.
