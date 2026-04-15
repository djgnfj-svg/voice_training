# Qwen3-TTS 마이그레이션 설계

**작성일**: 2026-04-15
**대상**: `tts/` 서비스 — OpenAI `gpt-4o-mini-tts` → Qwen3-TTS-1.7B 로컬 호스팅
**동기**: 자체 PC 배포로 전환하여 로컬 GPU(RTX 5070 Ti, 16GB VRAM) 활용 가능해짐. Qwen3-TTS는 Apache 2.0 오픈소스, 한국어 공식 지원, WER·화자 유사도 벤치마크 1위권.

## 1. 목표

- OpenAI TTS 의존 제거, 로컬 GPU 기반 고품질 한국어 TTS 제공
- 기존 5개 페르소나(default/interviewer/journal_friend/journal_counselor/tutor) 음색·톤 유지 또는 향상
- 기존 백엔드·프론트 API 시그니처 무변경 (tts 서비스 인터페이스 동일)
- 품질 확인 전까지 기존 OpenAI 경로 유지 → 점진 교체 + 즉시 롤백 가능

## 2. 비목표

- 보이스 클로닝 기반 커스텀 페르소나 (레퍼런스 오디오 녹음 부담)
- Qwen3-TTS 파인튜닝
- STT(Whisper) 교체 — 이 스펙 범위 밖

## 3. 아키텍처

### 3.1 서비스 구성

| 서비스 | 상태 | 역할 |
|---|---|---|
| `tts` (기존) | 유지 | OpenAI `gpt-4o-mini-tts` 래퍼, 포트 8080 (Docker 내부) |
| `tts-qwen3` (신규) | 추가 | Qwen3-TTS-1.7B 로컬 호스팅, 포트 8081 (Docker 내부) |

두 서비스는 동일한 HTTP 인터페이스(`POST /synthesize`)를 제공. 백엔드가 환경변수로 엔진 선택.

### 3.2 엔진 디스패처

**환경변수 신설**: `TTS_ENGINE=openai|qwen3` (기본 `openai`)

- `openai` → `http://tts:8080`
- `qwen3` → `http://tts-qwen3:8081`

백엔드(`backend/app/services/tts.py` 또는 동등 위치)가 디스패처 함수에서 URL 결정.
실패 시 기존 `edge-tts` 폴백 로직 그대로 재사용.

### 3.3 전환 경로

1. 양쪽 서비스 동시 기동
2. `/admin/voice-test`에서 엔진 드롭다운으로 A/B 청취
3. 만족 시 `TTS_ENGINE=qwen3` 환경변수 전환 + backend 재시작
4. 1~2주 안정성 확인 후 `tts/` 서비스 + `openai` SDK 의존 제거 (별도 커밋)

## 4. tts-qwen3 서비스 상세

### 4.1 모델 선정

- **모델**: `Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice`
- **이유**:
  - CustomVoice는 9개 프리셋 중 **"Sohee"**가 한국어 네이티브(따뜻하고 풍부한 감정의 여성 보이스)로 제공됨 — 면접관/저널 친구/상담사/튜터 톤 전체를 감당 가능
  - `speaker="Sohee"` + `instruct="...톤 지시..."` 조합으로 프리셋 안정성 + 페르소나 뉘앙스 둘 다 확보
  - `Base` 모델은 VoiceDesign 미지원(레퍼런스 오디오 필수)이라 제외
  - `VoiceDesign` 모델은 한국어 네이티브 프리셋이 없어 튜닝 부담 큼
- **라이선스**: Apache 2.0 (상업 사용 무제한)
- **하드웨어**: FP16/BF16 기준 VRAM 약 6~8GB 예상. RTX 5070 Ti 16GB 여유 있음

### 4.2 의존성

- 베이스 이미지: `nvidia/cuda:12.4.0-devel-ubuntu22.04` (flash-attn 빌드 필요 시 devel 필요)
- Python 3.12
- PyPI 패키지: `qwen-tts`, `torch` (CUDA 12.x 빌드), `fastapi`, `uvicorn`, `soundfile`, `pydantic`, `numpy`
- **FlashAttention 2**: `flash-attn` — RTX 5070 Ti(Blackwell, sm_120) 호환성 이슈 가능. 설치 실패 시 `attn_implementation="sdpa"`로 폴백(품질 영향 없음, 속도만 약간 감소)
- MP3 인코딩: `ffmpeg` 시스템 패키지 (apt-get) + `pydub` 또는 `soundfile`+`ffmpeg` 서브프로세스

### 4.3 엔드포인트 (기존 `tts` 시그니처 호환)

```
POST /synthesize
  Request: { text: str, persona?: str, speed?: float, voice?: str }
            (voice는 Qwen3에서 무시 — VoiceDesign 기반)
  Response: audio/mpeg

GET /health
  Response: { status, model, device, vram_used_mb }

GET /voices
  Response: { personas: [...], engine: "qwen3" }

POST /warmup
  Response: { status, warmup_ms }
  (컨테이너 시작 직후 1회 호출하여 첫 요청 지연 감소)
```

### 4.4 페르소나 처리 (CustomVoice + instruct 방식)

- 기본 speaker: `"Sohee"` (한국어 여성, 따뜻하고 감정 풍부) — 모든 페르소나 공용
- 페르소나별 톤 차이는 `instruct` 파라미터로 부여
- 기존 `tts/main.py`의 영문 `PERSONA_INSTRUCTIONS` 딕셔너리를 **한국어 번역본으로 변환**하여 `PERSONA_INSTRUCT_KO` 로 이식 (한국어 TTS에는 한국어 instruct가 더 효과적). 속도 힌트도 한국어로 변환
- 호출 예:
  ```python
  wavs, sr = model.generate_custom_voice(
      text=req.text,
      language="Korean",
      speaker="Sohee",
      instruct=PERSONA_INSTRUCT_KO[persona] + pace_hint_ko(speed),
  )
  ```
- 반환값: `(numpy float32 PCM, 24000)` → soundfile로 WAV 버퍼 생성 → ffmpeg으로 MP3 인코딩 (기존 응답 포맷 유지)

### 4.5 모델 로딩

```python
model = Qwen3TTSModel.from_pretrained(
    "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice",
    device_map="cuda:0",
    dtype=torch.bfloat16,
    attn_implementation=os.environ.get("QWEN3_ATTN", "flash_attention_2"),
)
```

- 첫 시작 시 HuggingFace Hub에서 가중치 다운로드 (~4GB)
- Docker named volume `qwen3-models` 에 캐시 (HF_HOME=/models)
- bfloat16, CUDA 상주 로드 (예상 VRAM 6~8GB)
- `QWEN3_ATTN` 환경변수로 어텐션 구현 선택 (flash-attn 실패 시 `sdpa`)
- `/warmup` 엔드포인트: 컨테이너 기동 직후 1회 호출하여 JIT 컴파일 및 CUDA 커널 워밍업

### 4.6 폴백 전략

- Qwen3 추론 예외 → HTTP 500 반환
- 백엔드가 받아서 `edge-tts`로 폴백 (기존 로직 그대로)
- Qwen3 컨테이너 다운 → 백엔드가 connect error로 판단 → `edge-tts` 폴백

## 5. 백엔드/프론트 통합

### 5.1 백엔드

- `TTS_ENGINE` 환경변수 추가 (docker-compose 양쪽)
- TTS 클라이언트/서비스 함수에서 엔진별 URL 분기
- 어드민 테스트 엔드포인트(`POST /api/admin/tts-test`)에 `engine` 파라미터 수용

### 5.2 어드민 UI (`/admin/voice-test` "TTS 발화" 탭)

- "엔진" 드롭다운 추가: `OpenAI (gpt-4o-mini-tts)` / `Qwen3-TTS`
- Qwen3 선택 시 voice 셀렉트는 숨김(의미 없음), 페르소나/속도만 조작
- 동시 A/B 재생은 하지 않음(단순 드롭다운 토글)

## 6. 배포 & 운영

### 6.1 docker-compose 변경 (dev + prod)

```yaml
tts-qwen3:
  build:
    context: ./tts-qwen3
  expose:
    - "8081"
  env_file:
    - ./backend/.env  # OPENAI_API_KEY 공유 필요 없음, 기타 공통 환경변수용
  volumes:
    - qwen3-models:/models
  deploy:
    resources:
      reservations:
        devices:
          - driver: nvidia
            count: 1
            capabilities: [gpu]
  restart: unless-stopped
```

`volumes:` 섹션에 `qwen3-models:` 추가 (dev/prod 프로젝트 prefix로 자동 분리)

### 6.2 사전 요구사항

- **Docker Desktop WSL2 백엔드** 활성화
- **NVIDIA Container Toolkit** 설치 (WSL2 환경에서 GPU 패스스루)
- 드라이버는 이미 설치됨 (nvidia-smi 확인 완료, 577.00 / CUDA 12.9)

### 6.3 자동 시작

- `restart: unless-stopped` — PC 재부팅 시 Docker Desktop과 함께 복구
- prod 프로젝트는 반드시 한 번 `docker compose -f docker-compose.prod.yml up -d` 기동해둘 것 (기존 자동 시작 규칙 준수)

### 6.4 롤백

- `TTS_ENGINE=openai` 환경변수 변경 + backend 재시작 (즉시)
- `docker compose stop tts-qwen3` 로 자원 반납 가능

## 7. 커밋 분할 (메모리 선호 반영)

1. `feat(tts): Qwen3-TTS 서비스 컨테이너 추가 (tts-qwen3)`
2. `feat(tts): backend에 TTS_ENGINE 디스패처 추가`
3. `feat(admin): voice-test에 엔진 선택 UI`
4. `docs: TTS 엔진 전환 가이드 (CLAUDE.md 업데이트)`
5. (품질 확인 후 별도) `chore(tts): OpenAI tts 서비스 및 SDK 의존 제거`

## 8. 테스트 계획

- `GET /health` — VRAM 점유 확인
- `POST /warmup` 후 `POST /synthesize` 레이턴시 측정 (200자 한국어 기준, TTFB + 전체)
- `/admin/voice-test`에서 5개 페르소나 × 2~3 문장 청취 비교
- 실제 시나리오 리그레션:
  - 면접 세션 1회 (interviewer 페르소나)
  - 저널 세션 1회 (journal_friend/counselor 페르소나)
  - 학습 세션 1회 (tutor 페르소나)
- 오디오 끊김/지연/음량 이상 없는지 확인

## 9. 리스크 & 완화

| 리스크 | 완화책 |
|---|---|
| NVIDIA Container Toolkit 미설치 | 컨테이너 기동 실패 시 안내, 설치 가이드 문서화 |
| Qwen3 첫 요청 지연 (모델 로드 15~30s) | `/warmup` 엔드포인트 + 컨테이너 헬스체크 후 warmup 자동 호출 |
| Sohee 프리셋이 모든 페르소나(면접관/저널/상담사/튜터)에 적합하지 않을 가능성 | CustomVoice는 instruct로 톤 변조 가능. 심각할 경우 페르소나별로 9개 프리셋 중 재매핑 가능(Aiden/Ryan 등 영어 남성 프리셋도 한국어로 시도 가능) |
| FlashAttention 2가 RTX 5070 Ti(Blackwell)에서 빌드 실패 | `QWEN3_ATTN=sdpa` 환경변수로 즉시 전환. 품질 동일, 속도 약 20% 감소 예상 |
| VRAM 부족 (다른 프로세스와 경쟁) | FP16 기본, 최악의 경우 INT8 양자화 옵션 |
| 빌드 시간 (CUDA 이미지 + PyTorch) | named volume으로 모델 캐시, Docker layer 캐시 활용 |

## 10. 성공 기준

- 5개 페르소나 모두 한국어 발음 자연스러움 (주관 평가 A/B 청취)
- 평균 TTFB ≤ 500ms, 200자 합성 총 시간 ≤ 2s (RTX 5070 Ti 기준)
- 면접/저널/학습 시나리오에서 오디오 품질 저하 없음
- OpenAI TTS 호출 0건 (로그 확인)
- 월 OpenAI TTS 비용 0원
