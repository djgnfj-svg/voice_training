# TTS 속도 측정 (2026-04-13)

측정: `voice_training-tts-1` 컨테이너, `POST /synthesize` 직접 호출 (backend 컨테이너 내부 네트워크 경유). 한국어 샘플 3종 × persona 2종 × speed 3종, MP3 duration은 `mutagen`으로 추출.

## 핵심 결론

1. **`speed` 파라미터는 사실상 무력**
   - `gpt-4o-mini-tts`: long 129자 기준 1.0x=17.81s, 2.0x=16.42s → 실제 단축 8% 수준
   - `tts-1`: 1.0x=18.22s, 2.0x=18.72s → **오히려 2.0x가 더 김** (샘플링 편차)
   - 즉 `TTS_SPEED=2.0` 환경변수는 체감상 의미 없음. 속도 올리려면 **instructions 프롬프트**(`"Speak very fast..."`) 가 더 확실.
2. **실 발화 속도**: 약 **6~7 chars/sec** (한국어, 공백 포함).
   - 짧은 문장은 앞뒤 호흡 때문에 약 5.3 chars/sec, 긴 문장은 7.2 chars/sec로 빨라짐.
3. **Real-Time Factor (RTF = 생성시간/오디오길이)**: **0.18~0.37**. 오디오 1초 만드는 데 0.2~0.3초. 스트리밍 안 해도 충분히 빠름.
4. **생성 오버헤드**: 약 **1초 기본 + 0.02초/글자**. 27자 ≈ 1.5s, 63자 ≈ 2s, 129자 ≈ 3.3s.
5. **`gpt-4o-mini-tts`와 `tts-1` 속도 차이 없음**. 둘 다 동일한 응답 시간·발화 속도. 모델 선택 기준은 "페르소나(instructions) 지원 여부"만 남음.

## 면접 TTS 고도화 시사점

- 질문 하나당 **1.5~3.5초 생성 지연**은 유저 기다림으로 체감됨 → **사전 생성(pre-buffer)** 또는 **스트리밍 재생**을 고려.
  - 에이전트 면접은 질문을 1개씩 동적 생성하므로, 현 구조에선 "LLM 질문 생성 완료 → TTS → 재생" 순차 대기 = **총 3~6초 지연**.
  - 개선안: ① TTS를 청크 스트리밍(`with_streaming_response` 이미 사용 중이나 서버에서 모아 반환) → 클라이언트 chunked 재생, ② 다음 질문을 사용자 답변 중 미리 생성.
- `speed` 파라미터 조절 UI를 만들 거면 **허상**. instructions에 톤 힌트 넣는 방식을 유지하거나, 클라이언트 `<audio playbackRate>`로 재생 속도 조절이 현실적.
- "마이크 확인 다이얼로그" 직전에 첫 질문 TTS 미리 warm-up 요청 → 체감 지연 숨김 가능.

## 원시 데이터

| label | model | persona | speed | chars | gen_s | audio_s | RTF | chars/s |
|-------|-------|---------|------:|------:|------:|--------:|----:|--------:|
| short (27자) | gpt-4o-mini-tts | default | 1.0 | 27 | 1.55 | 5.06 | 0.31 | 5.33 |
| short (27자) | gpt-4o-mini-tts | default | 1.5 | 27 | 1.40 | 4.66 | 0.30 | 5.80 |
| short (27자) | gpt-4o-mini-tts | default | 2.0 | 27 | 1.65 | 4.51 | 0.37 | 5.98 |
| short (27자) | gpt-4o-mini-tts | interviewer | 1.0 | 27 | 1.52 | 4.25 | 0.36 | 6.36 |
| short (27자) | gpt-4o-mini-tts | interviewer | 1.5 | 27 | 1.37 | 4.70 | 0.29 | 5.74 |
| short (27자) | gpt-4o-mini-tts | interviewer | 2.0 | 27 | 1.44 | 4.97 | 0.29 | 5.43 |
| medium (63자) | gpt-4o-mini-tts | default | 1.0 | 63 | 1.99 | 9.46 | 0.21 | 6.66 |
| medium (63자) | gpt-4o-mini-tts | default | 1.5 | 63 | 2.19 | 10.06 | 0.22 | 6.26 |
| medium (63자) | gpt-4o-mini-tts | default | 2.0 | 63 | 2.03 | 9.91 | 0.20 | 6.36 |
| medium (63자) | gpt-4o-mini-tts | interviewer | 1.0 | 63 | 2.10 | 9.82 | 0.21 | 6.42 |
| medium (63자) | gpt-4o-mini-tts | interviewer | 1.5 | 63 | 2.03 | 10.01 | 0.20 | 6.29 |
| medium (63자) | gpt-4o-mini-tts | interviewer | 2.0 | 63 | 2.12 | 10.37 | 0.20 | 6.08 |
| long (129자) | gpt-4o-mini-tts | default | 1.0 | 129 | 3.32 | 17.81 | 0.19 | 7.24 |
| long (129자) | gpt-4o-mini-tts | default | 1.5 | 129 | 3.45 | 17.90 | 0.19 | 7.21 |
| long (129자) | gpt-4o-mini-tts | default | 2.0 | 129 | 3.26 | 16.42 | 0.20 | 7.86 |
| long (129자) | gpt-4o-mini-tts | interviewer | 1.0 | 129 | 3.55 | 18.17 | 0.20 | 7.10 |
| long (129자) | gpt-4o-mini-tts | interviewer | 1.5 | 129 | 3.34 | 16.56 | 0.20 | 7.79 |
| long (129자) | gpt-4o-mini-tts | interviewer | 2.0 | 129 | 3.31 | 18.31 | 0.18 | 7.04 |
| short (27자) | tts-1 | default | 1.0 | 27 | 1.97 | 4.32 | 0.46 | 6.25 |
| short (27자) | tts-1 | default | 1.5 | 27 | 1.45 | 4.61 | 0.31 | 5.86 |
| short (27자) | tts-1 | default | 2.0 | 27 | 1.32 | 4.75 | 0.28 | 5.68 |
| medium (63자) | tts-1 | default | 1.0 | 63 | 2.64 | 9.77 | 0.27 | 6.45 |
| medium (63자) | tts-1 | default | 1.5 | 63 | 2.09 | 10.20 | 0.20 | 6.18 |
| medium (63자) | tts-1 | default | 2.0 | 63 | 2.93 | 10.20 | 0.29 | 6.18 |
| long (129자) | tts-1 | default | 1.0 | 129 | 3.96 | 18.22 | 0.22 | 7.08 |
| long (129자) | tts-1 | default | 1.5 | 129 | 3.29 | 17.71 | 0.19 | 7.28 |
| long (129자) | tts-1 | default | 2.0 | 129 | 3.63 | 18.72 | 0.19 | 6.89 |

- `gen_s`: `POST /synthesize` 요청 → 응답 바디 수신 완료까지의 wall time (backend ↔ tts 내부 네트워크).
- `audio_s`: 반환된 MP3의 실제 재생 길이 (mutagen `MP3.info.length`).
- `RTF`: `gen_s / audio_s` — 오디오 1초 생성에 든 처리 시간. 낮을수록 빠름.
- `chars/s`: `chars / audio_s` — 실제 발화 속도.
- 비트레이트는 전 샘플 128 kbps CBR.

## 샘플 텍스트

- short (27자): "안녕하세요. 오늘 면접에 참여해주셔서 감사합니다."
- medium (63자): "자기소개를 부탁드립니다. 본인의 경력과 강점, 그리고 이번 포지션에 관심을 가지게 된 계기를 편하게 말씀해주세요."
- long (129자): "React 에서 컴포넌트 리렌더링을 최적화하기 위해 사용하는 memo, useMemo, useCallback 의 차이를 설명해주시고, 실제 프로젝트에서 어떤 상황에 각각을 선택하셨는지 구체적인 예시와 함께 말씀해 주시면 좋겠습니다."
