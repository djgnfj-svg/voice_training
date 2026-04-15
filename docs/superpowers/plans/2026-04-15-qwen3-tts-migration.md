# Qwen3-TTS Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** OpenAI `gpt-4o-mini-tts` → 로컬 GPU `Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice` (Sohee 프리셋) 점진 교체. 기존 `tts/` 서비스는 유지하고 `tts-qwen3/` 서비스를 신규 추가하여 `/admin/voice-test`에서 엔진 A/B 가능하도록 한다.

**Architecture:** 신규 컨테이너 `tts-qwen3` 가 `Qwen3TTSModel`을 bfloat16으로 GPU에 상주 로드. FastAPI로 기존 `tts` 서비스와 동일한 `POST /synthesize` 인터페이스 제공. 백엔드는 `TTS_ENGINE` 환경변수(`openai|qwen3`)로 대상 URL 선택. 어드민은 요청 바디 `engine` 필드로 기본값 오버라이드.

**Tech Stack:** Python 3.12, `qwen-tts` PyPI, PyTorch + CUDA 12.x, `soundfile`, `ffmpeg`, FastAPI, Docker + NVIDIA Container Toolkit, Next.js (관리자 UI).

**Reference spec:** `docs/superpowers/specs/2026-04-15-qwen3-tts-migration-design.md`

---

## File Structure

### 신규 생성
- `tts-qwen3/Dockerfile` — CUDA 이미지 + qwen-tts + ffmpeg
- `tts-qwen3/requirements.txt` — Python 의존성
- `tts-qwen3/main.py` — FastAPI 앱, `POST /synthesize`, `GET /health`, `GET /voices`, `POST /warmup`
- `backend/tests/unit/test_tts_dispatcher.py` — 엔진 디스패처 단위 테스트

### 수정
- `docker-compose.yml` (dev) — `tts-qwen3` 서비스 + `qwen3-models` named volume 추가
- `docker-compose.prod.yml` — 동일
- `backend/app/routers/speech.py` — `TTS_ENGINE` 환경변수 + `engine` 요청 필드 지원
- `frontend/src/app/(authenticated)/admin/voice-test/page.tsx` — TTS 패널에 엔진 셀렉트 추가
- `CLAUDE.md` — TTS 섹션 업데이트

---

## Task 1: tts-qwen3 서비스 스캐폴드 (건강체크만)

**목적:** Docker + GPU 패스스루가 정상 동작하는지 먼저 확인. 모델 로드 없이 `nvidia-smi`가 컨테이너 안에서 보이는 최소 이미지.

**Files:**
- Create: `tts-qwen3/Dockerfile`
- Create: `tts-qwen3/requirements.txt`
- Create: `tts-qwen3/main.py`

- [ ] **Step 1: `tts-qwen3/requirements.txt` 작성**

```
fastapi>=0.115
uvicorn[standard]>=0.30
pydantic>=2.7
```

- [ ] **Step 2: `tts-qwen3/main.py` 스캐폴드 작성 (모델 없음)**

```python
from __future__ import annotations

import logging
import os
import subprocess

from fastapi import FastAPI

logger = logging.getLogger("tts-qwen3")
logging.basicConfig(level=logging.INFO)

app = FastAPI()

MODEL_NAME = os.environ.get("QWEN3_MODEL", "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice")


@app.get("/health")
def health():
    gpu_info = "unavailable"
    try:
        out = subprocess.check_output(
            ["nvidia-smi", "--query-gpu=name,memory.used,memory.total", "--format=csv,noheader"],
            timeout=5,
        )
        gpu_info = out.decode().strip()
    except Exception:
        pass
    return {"status": "ok", "model": MODEL_NAME, "loaded": False, "gpu": gpu_info}
```

- [ ] **Step 3: `tts-qwen3/Dockerfile` 작성**

```dockerfile
FROM nvidia/cuda:12.4.0-devel-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    HF_HOME=/models \
    XDG_CACHE_HOME=/models

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3.12 python3.12-venv python3-pip \
    ffmpeg libsndfile1 git \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sf /usr/bin/python3.12 /usr/bin/python

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py .

EXPOSE 8081

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8081"]
```

- [ ] **Step 4: 로컬 빌드 & 기동 확인 (수동)**

Run:
```bash
cd tts-qwen3
docker build -t tts-qwen3-test .
docker run --rm --gpus all -p 18081:8081 tts-qwen3-test &
sleep 5
curl -sf http://localhost:18081/health
docker stop $(docker ps -q --filter ancestor=tts-qwen3-test)
```

Expected: `{"status":"ok","model":"Qwen/...","loaded":false,"gpu":"NVIDIA GeForce RTX 5070 Ti, ... MiB, 16303 MiB"}`

If `nvidia-smi` not found: Docker Desktop의 WSL2 + NVIDIA Container Toolkit 설치 필요. 설치 안내: https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html#with-apt-ubuntu

- [ ] **Step 5: 커밋**

```bash
git add tts-qwen3/
git commit -m "feat(tts): tts-qwen3 서비스 스캐폴드 (health only)"
```

---

## Task 2: Qwen3-TTS 모델 로딩 + /synthesize 구현

**Files:**
- Modify: `tts-qwen3/requirements.txt`
- Modify: `tts-qwen3/main.py`
- Modify: `tts-qwen3/Dockerfile` (flash-attn 조건부 설치)

- [ ] **Step 1: `requirements.txt` 에 qwen-tts + torch + 인코딩 의존성 추가**

```
fastapi>=0.115
uvicorn[standard]>=0.30
pydantic>=2.7
torch==2.4.0
qwen-tts
soundfile>=0.12
numpy>=1.26
```

(flash-attn은 빌드 길고 Blackwell 호환성 미확인이라 Dockerfile에서 `||true`로 best-effort 설치)

- [ ] **Step 2: `Dockerfile` 수정 — flash-attn best-effort 설치**

변경: `RUN pip install --no-cache-dir -r requirements.txt` 아래에 추가:

```dockerfile
RUN pip install --no-cache-dir -r requirements.txt
# flash-attn은 Blackwell(RTX 50) 호환성 확인 안 됨 → 실패해도 sdpa로 폴백
RUN MAX_JOBS=4 pip install --no-cache-dir flash-attn --no-build-isolation || echo "flash-attn install failed, will use sdpa"
```

- [ ] **Step 3: `main.py` 에 페르소나 매핑 (한국어 instruct) 추가**

`main.py` 상단(기존 imports 아래)에 추가:

```python
PERSONA_INSTRUCT_KO = {
    "default": "자연스럽고 따뜻한 한국어로, 자신감 있고 부드러운 톤으로 말해주세요.",
    "interviewer": "한국 IT 회사의 전문 면접관처럼, 또렷하고 자신감 있으며 조금 빠른 말투로 말해주세요. 중립적이고 프로페셔널하되 로봇 같지 않게.",
    "journal_friend": "가까운 친구와 커피를 마시며 편안하게 대화하듯, 따뜻하고 공감어린 톤으로 자연스럽게 말해주세요.",
    "journal_counselor": "차분하고 공감적인 상담사처럼, 천천히 따뜻하게 자연스러운 멈춤을 섞어 부드럽게 말해주세요.",
    "tutor": "학생이 잘 이해하길 바라는 친절한 선생님처럼, 또렷하고 활기차지만 서두르지 않는 속도로 말해주세요.",
}


def _pace_hint_ko(speed: float) -> str:
    if speed >= 1.7:
        return " 아주 빠르고 급한 속도로 말해주세요."
    if speed >= 1.4:
        return " 눈에 띄게 빠르고 에너지 있게 말해주세요."
    if speed >= 1.2:
        return " 약간 빠른, 경쾌한 속도로 말해주세요."
    if speed <= 0.7:
        return " 아주 천천히, 신중하게, 긴 멈춤을 섞어 말해주세요."
    if speed <= 0.85:
        return " 느리고 차분한 속도로 말해주세요."
    return ""
```

- [ ] **Step 4: `main.py` 에 모델 로딩 + /synthesize 구현**

`main.py` 끝 부분(`@app.get("/health")` 위)에 추가:

```python
import io
import subprocess
import threading
from typing import Optional

import soundfile as sf
import torch
from fastapi import HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field

DEFAULT_SPEAKER = os.environ.get("QWEN3_SPEAKER", "Sohee")
ATTN_IMPL = os.environ.get("QWEN3_ATTN", "flash_attention_2")
DEFAULT_SPEED = float(os.environ.get("TTS_SPEED", "1.0"))

_model = None
_model_lock = threading.Lock()


def _load_model():
    global _model
    if _model is not None:
        return _model
    with _model_lock:
        if _model is not None:
            return _model
        logger.info("Loading Qwen3-TTS model: %s (attn=%s)", MODEL_NAME, ATTN_IMPL)
        from qwen_tts import Qwen3TTSModel

        try:
            _model = Qwen3TTSModel.from_pretrained(
                MODEL_NAME,
                device_map="cuda:0",
                dtype=torch.bfloat16,
                attn_implementation=ATTN_IMPL,
            )
        except Exception as e:
            if ATTN_IMPL != "sdpa":
                logger.warning("Failed with attn=%s (%s). Retrying with sdpa.", ATTN_IMPL, type(e).__name__)
                _model = Qwen3TTSModel.from_pretrained(
                    MODEL_NAME,
                    device_map="cuda:0",
                    dtype=torch.bfloat16,
                    attn_implementation="sdpa",
                )
            else:
                raise
        logger.info("Qwen3-TTS loaded")
        return _model


class SynthesizeRequest(BaseModel):
    text: str = Field(min_length=1, max_length=4096)
    voice: Optional[str] = None
    persona: Optional[str] = None
    speed: Optional[float] = None
    model: Optional[str] = None


def _pcm_to_mp3(pcm, sr: int) -> bytes:
    wav_buf = io.BytesIO()
    sf.write(wav_buf, pcm, sr, format="WAV")
    wav_buf.seek(0)
    proc = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", "pipe:0",
         "-f", "mp3", "-b:a", "128k", "pipe:1"],
        input=wav_buf.read(), capture_output=True, check=True,
    )
    return proc.stdout


@app.post("/synthesize")
def synthesize(req: SynthesizeRequest):
    persona = req.persona or "default"
    speed = req.speed if req.speed is not None else DEFAULT_SPEED
    speaker = req.voice or DEFAULT_SPEAKER
    instruct = PERSONA_INSTRUCT_KO.get(persona, PERSONA_INSTRUCT_KO["default"]) + _pace_hint_ko(speed)

    try:
        model = _load_model()
        with torch.inference_mode():
            wavs, sr = model.generate_custom_voice(
                text=req.text,
                language="Korean",
                speaker=speaker,
                instruct=instruct,
            )
        pcm = wavs[0] if hasattr(wavs, "__len__") and len(wavs) > 0 else wavs
        mp3 = _pcm_to_mp3(pcm, int(sr))
    except Exception as e:
        logger.exception("Qwen3-TTS synthesize failed")
        raise HTTPException(500, f"TTS failed: {type(e).__name__}")

    return Response(
        content=mp3,
        media_type="audio/mpeg",
        headers={"Content-Length": str(len(mp3))},
    )


@app.get("/voices")
def voices():
    return {
        "voices": ["Sohee", "Vivian", "Serena", "Uncle_Fu", "Dylan", "Eric", "Ryan", "Aiden", "Ono_Anna"],
        "default": DEFAULT_SPEAKER,
        "personas": list(PERSONA_INSTRUCT_KO.keys()),
    }


@app.post("/warmup")
def warmup():
    import time
    t0 = time.perf_counter()
    _load_model()
    # 짧은 문장 1회 추론하여 CUDA 커널 워밍업
    try:
        model = _load_model()
        with torch.inference_mode():
            model.generate_custom_voice(
                text="안녕하세요.",
                language="Korean",
                speaker=DEFAULT_SPEAKER,
                instruct=PERSONA_INSTRUCT_KO["default"],
            )
    except Exception:
        logger.exception("Warmup inference failed (non-fatal)")
    return {"status": "ok", "warmup_ms": int((time.perf_counter() - t0) * 1000)}
```

또한 기존 `health()` 에서 `loaded` 필드를 `_model is not None`로 변경:

```python
@app.get("/health")
def health():
    # ...기존 gpu_info 블록 유지...
    return {"status": "ok", "model": MODEL_NAME, "loaded": _model is not None, "gpu": gpu_info}
```

- [ ] **Step 5: 수동 빌드 & 합성 테스트**

Run:
```bash
cd tts-qwen3
docker build -t tts-qwen3-test .
docker run --rm --gpus all -v qwen3-models-test:/models -p 18081:8081 tts-qwen3-test &
# 첫 기동은 모델 다운로드로 수분 소요
until curl -sf http://localhost:18081/health > /dev/null; do sleep 2; done
curl -X POST http://localhost:18081/warmup
curl -X POST http://localhost:18081/synthesize \
  -H "Content-Type: application/json" \
  -d '{"text":"안녕하세요. 오늘 기술 면접을 시작하겠습니다.","persona":"interviewer"}' \
  --output /tmp/qwen3-sample.mp3
file /tmp/qwen3-sample.mp3
docker stop $(docker ps -q --filter ancestor=tts-qwen3-test)
```

Expected: `Audio file with ID3 version ...` 또는 `MPEG ADTS, layer III` 형태의 파일 (수 KB~수백 KB).

재생하여 한국어 발화 자연스러운지 확인.

- [ ] **Step 6: 커밋**

```bash
git add tts-qwen3/
git commit -m "feat(tts): Qwen3-TTS CustomVoice 모델 로딩 + /synthesize + /warmup"
```

---

## Task 3: docker-compose 에 tts-qwen3 서비스 추가 (dev + prod)

**Files:**
- Modify: `docker-compose.yml`
- Modify: `docker-compose.prod.yml`

- [ ] **Step 1: `docker-compose.yml` 에 `tts-qwen3` 서비스 + volume 추가**

`docker-compose.yml`의 `tts:` 서비스 블록 **아래**에 추가 (들여쓰기 2 space 유지):

```yaml
  tts-qwen3:
    build:
      context: ./tts-qwen3
    expose:
      - "8081"
    environment:
      - QWEN3_MODEL=Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice
      - QWEN3_SPEAKER=Sohee
      - QWEN3_ATTN=flash_attention_2
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

그리고 파일 끝의 `volumes:` 섹션에 `qwen3-models:` 추가:

```yaml
volumes:
  audio-storage:
  qwen3-models:
```

- [ ] **Step 2: `docker-compose.prod.yml` 에 동일 내용 추가**

동일 블록 + 볼륨을 추가. prod 프로젝트명(`voiceprep-prod`) 덕분에 dev와 완전 격리됨.

- [ ] **Step 3: dev 환경 기동 & health 확인**

Run:
```bash
docker compose up -d tts-qwen3
docker compose logs -f tts-qwen3 &
# 모델 로드 대기 (첫 기동은 다운로드 때문에 수분)
until docker compose exec -T tts-qwen3 curl -sf http://localhost:8081/health > /dev/null 2>&1; do sleep 5; done
docker compose exec -T backend curl -sf http://tts-qwen3:8081/health
```

Expected: backend 컨테이너에서 tts-qwen3 health 응답 받을 수 있어야 함(같은 네트워크 확인).

- [ ] **Step 4: 커밋**

```bash
git add docker-compose.yml docker-compose.prod.yml
git commit -m "feat(tts): docker-compose 양쪽에 tts-qwen3 서비스 + GPU 패스스루"
```

---

## Task 4: backend 엔진 디스패처 (TDD)

**Files:**
- Create: `backend/tests/unit/test_tts_dispatcher.py`
- Modify: `backend/app/routers/speech.py`

- [ ] **Step 1: 디스패처 단위 테스트 작성 (실패 예상)**

`backend/tests/unit/test_tts_dispatcher.py`:

```python
import pytest
from unittest.mock import AsyncMock, patch

from app.routers import speech


@pytest.mark.asyncio
async def test_dispatcher_default_engine_routes_to_openai(monkeypatch):
    monkeypatch.setenv("TTS_ENGINE", "openai")
    monkeypatch.setattr(speech, "TTS_OPENAI_URL", "http://tts:8080")
    monkeypatch.setattr(speech, "TTS_QWEN3_URL", "http://tts-qwen3:8081")
    monkeypatch.setattr(speech, "TTS_ENGINE", "openai")

    assert speech._resolve_tts_url(None) == "http://tts:8080"


@pytest.mark.asyncio
async def test_dispatcher_explicit_qwen3_overrides_default(monkeypatch):
    monkeypatch.setattr(speech, "TTS_OPENAI_URL", "http://tts:8080")
    monkeypatch.setattr(speech, "TTS_QWEN3_URL", "http://tts-qwen3:8081")
    monkeypatch.setattr(speech, "TTS_ENGINE", "openai")

    assert speech._resolve_tts_url("qwen3") == "http://tts-qwen3:8081"


@pytest.mark.asyncio
async def test_dispatcher_unknown_engine_raises(monkeypatch):
    monkeypatch.setattr(speech, "TTS_OPENAI_URL", "http://tts:8080")
    monkeypatch.setattr(speech, "TTS_QWEN3_URL", "http://tts-qwen3:8081")
    monkeypatch.setattr(speech, "TTS_ENGINE", "openai")

    with pytest.raises(ValueError):
        speech._resolve_tts_url("bogus")
```

- [ ] **Step 2: 테스트 실행 — 실패 확인**

Run: `docker compose exec -T backend pytest backend/tests/unit/test_tts_dispatcher.py -v`
Expected: `AttributeError: module 'app.routers.speech' has no attribute '_resolve_tts_url'` 로 실패

- [ ] **Step 3: `speech.py` 수정 — 환경변수 상수 + 디스패처 함수 + engine 필드**

현재:
```python
TTS_SERVICE_URL = os.environ.get("TTS_SERVICE_URL", "http://tts:8080")
TTS_TIMEOUT = float(os.environ.get("TTS_TIMEOUT", "30"))
```

다음으로 교체:

```python
TTS_ENGINE = os.environ.get("TTS_ENGINE", "openai")
TTS_OPENAI_URL = os.environ.get("TTS_OPENAI_URL", os.environ.get("TTS_SERVICE_URL", "http://tts:8080"))
TTS_QWEN3_URL = os.environ.get("TTS_QWEN3_URL", "http://tts-qwen3:8081")
TTS_TIMEOUT = float(os.environ.get("TTS_TIMEOUT", "30"))


def _resolve_tts_url(engine: str | None) -> str:
    eng = (engine or TTS_ENGINE).lower()
    if eng == "openai":
        return TTS_OPENAI_URL
    if eng == "qwen3":
        return TTS_QWEN3_URL
    raise ValueError(f"Unknown TTS engine: {eng}")
```

그리고 `TTSRequest` 에 `engine` 필드 추가:

```python
class TTSRequest(BaseModel):
    text: str = Field(min_length=1, max_length=4096)
    voice: str | None = None
    persona: str | None = None
    speed: float | None = Field(default=None, ge=0.25, le=4.0)
    model: str | None = None
    engine: str | None = None  # "openai" | "qwen3" — 기본은 TTS_ENGINE env
```

`_tts_synthesize` 시그니처에 `engine` 추가 + URL 해석:

```python
async def _tts_synthesize(
    text: str,
    voice: str | None,
    persona: str | None,
    speed: float | None,
    model: str | None,
    engine: str | None = None,
) -> tuple[bytes, str]:
    payload: dict = {"text": text}
    if voice:
        payload["voice"] = voice
    if persona:
        payload["persona"] = persona
    if speed is not None:
        payload["speed"] = speed
    if model:
        payload["model"] = model
    base_url = _resolve_tts_url(engine)
    async with httpx.AsyncClient(timeout=TTS_TIMEOUT) as client:
        res = await client.post(f"{base_url}/synthesize", json=payload)
        res.raise_for_status()
        return res.content, res.headers.get("content-type", "audio/mpeg")
```

그리고 `text_to_speech` 라우터 호출 지점에서 `body.engine` 전달:

```python
audio, media_type = await _tts_synthesize(
    cleaned, body.voice, body.persona, body.speed, body.model, body.engine,
)
```

- [ ] **Step 4: 테스트 실행 — 통과 확인**

Run: `docker compose exec -T backend pytest backend/tests/unit/test_tts_dispatcher.py -v`
Expected: 3 passed

- [ ] **Step 5: 백엔드 재시작 & 엔진 전환 스모크 테스트**

Run:
```bash
# OpenAI 기본 경로 확인
docker compose restart backend nginx
curl -sI http://localhost:81/api/tts -X POST -H "Content-Type: application/json" \
  --data '{"text":"테스트","persona":"default"}' \
  -H "Cookie: __Secure-authjs.session-token=<test user token>" | head -5
# (세션 쿠키 없으면 401 — 정상. 라우팅만 확인)

# qwen3 엔진 override (admin 권한 유저 쿠키 필요)
curl -X POST http://localhost:81/api/tts \
  -H "Content-Type: application/json" \
  -H "Cookie: __Secure-authjs.session-token=<admin user token>" \
  --data '{"text":"안녕하세요","persona":"interviewer","engine":"qwen3"}' \
  --output /tmp/qwen3-via-backend.mp3
file /tmp/qwen3-via-backend.mp3
```

Expected: `/tmp/qwen3-via-backend.mp3`가 유효한 MP3 파일. 재생 시 Sohee 보이스.

- [ ] **Step 6: 커밋**

```bash
git add backend/app/routers/speech.py backend/tests/unit/test_tts_dispatcher.py
git commit -m "feat(tts): backend에 TTS_ENGINE 디스패처 + TTSRequest.engine 필드"
```

---

## Task 5: 어드민 voice-test UI 에 엔진 셀렉트 추가

**Files:**
- Modify: `frontend/src/app/(authenticated)/admin/voice-test/page.tsx`

- [ ] **Step 1: `TTSTestPanel`에 엔진 상태 + 셀렉트 추가**

`TTSTestPanel` 함수 내 기존 state 선언부(`const [voice, setVoice] = useState('sage');`) **위**에 추가:

```typescript
const TTS_ENGINES = [
  { value: 'openai', label: 'OpenAI (gpt-4o-mini-tts)' },
  { value: 'qwen3', label: 'Qwen3-TTS (로컬 GPU)' },
];
```

(기존 `TTS_VOICES`, `TTS_PERSONAS`, `TTS_MODELS` 상수 위, `DEFAULT_TEXT` 근처가 자연스러움)

`TTSTestPanel` 내부 state 블록에 추가:

```typescript
const [engine, setEngine] = useState<'openai' | 'qwen3'>('openai');
```

- [ ] **Step 2: 요청 바디에 `engine` 포함**

`handlePlay` 내 `body: JSON.stringify({...})` 를 다음으로 교체:

```typescript
body: JSON.stringify({ text, voice, persona, speed, model, engine }),
```

- [ ] **Step 3: UI에 엔진 드롭다운 추가 + Qwen3일 때 model/voice 영역 숨김**

기존 "모델" 셀렉트 블록 **위**에 엔진 셀렉트 추가:

```tsx
<div className="space-y-2">
  <Label>엔진</Label>
  <Select value={engine} onValueChange={(v) => setEngine(v as 'openai' | 'qwen3')}>
    <SelectTrigger><SelectValue /></SelectTrigger>
    <SelectContent>
      {TTS_ENGINES.map(e => <SelectItem key={e.value} value={e.value}>{e.label}</SelectItem>)}
    </SelectContent>
  </Select>
</div>
```

그리고 기존 "모델" 셀렉트 블록 전체와 "보이스" 셀렉트 블록을 `{engine === 'openai' && ( ... )}`로 감싸기:

```tsx
{engine === 'openai' && (
  <div className="space-y-2">
    <Label>모델</Label>
    <Select value={model} onValueChange={setModel}>
      {/* 기존 내용 */}
    </Select>
  </div>
)}

<div className="grid gap-4 md:grid-cols-3">
  {engine === 'openai' && (
    <div className="space-y-2">
      <Label>보이스</Label>
      <Select value={voice} onValueChange={setVoice}>
        {/* 기존 내용 */}
      </Select>
    </div>
  )}
  {/* 페르소나 셀렉트는 양쪽 공통 유지 */}
  {/* 속도 슬라이더도 양쪽 공통 유지 */}
</div>
```

Qwen3에서는 Sohee 고정이므로 voice 숨김. 모델도 CustomVoice 고정이라 숨김.

- [ ] **Step 4: CardDescription 업데이트**

```tsx
<CardDescription>
  엔진 / 페르소나 / 속도 조합으로 TTS 품질 비교 (OpenAI vs Qwen3)
</CardDescription>
```

- [ ] **Step 5: 수동 UI 확인**

Run:
```bash
docker compose build frontend && docker compose up -d frontend
```

브라우저에서 `http://localhost:81/admin/voice-test` 접속 (어드민 이메일로 로그인). 다음 확인:
- "엔진" 드롭다운 존재, 2개 옵션
- OpenAI 선택 → 모델/보이스 드롭다운 표시
- Qwen3 선택 → 모델/보이스 드롭다운 숨김, 페르소나/속도만 표시
- 각 엔진에서 "재생" 클릭 시 정상 합성 & 재생

- [ ] **Step 6: 커밋**

```bash
git add frontend/src/app/\(authenticated\)/admin/voice-test/page.tsx
git commit -m "feat(admin): voice-test에 TTS 엔진 셀렉트 추가 (OpenAI/Qwen3)"
```

---

## Task 6: CLAUDE.md 업데이트

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: TTS 섹션 업데이트**

현재 `CLAUDE.md`의 **"TTS — **OpenAI `gpt-4o-mini-tts`** ..."** 문장 교체:

```markdown
- TTS — 듀얼 엔진 구성. 엔진 선택은 backend의 `TTS_ENGINE` 환경변수 (`openai` | `qwen3`, 기본 `openai`)
  - **`tts` 서비스**: OpenAI `gpt-4o-mini-tts` (voice `sage`, speed 2.0x, 페르소나 5종)
  - **`tts-qwen3` 서비스**: 로컬 GPU `Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice` (Sohee 프리셋, bfloat16, ~6GB VRAM)
  - 실패 시 `edge-tts`로 자동 폴백. 어드민은 `/admin/voice-test` 에서 엔진 A/B 청취 가능
```

그리고 **"TTS 서비스 (`tts/`)"** 섹션 **아래**에 새 섹션 추가:

```markdown
### TTS-Qwen3 서비스 (`tts-qwen3/`)
- FastAPI + qwen-tts PyPI, 포트 8081 (Docker 내부)
- 모델: `Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice` (Apache 2.0, 한국어 네이티브 Sohee 프리셋)
- 엔드포인트: `POST /synthesize`, `GET /health`, `GET /voices`, `POST /warmup`
- 페르소나는 한국어 `instruct` 파라미터로 지시 (`PERSONA_INSTRUCT_KO` 딕셔너리, tts-qwen3/main.py)
- GPU 패스스루 필수 — Docker Desktop WSL2 + NVIDIA Container Toolkit
- `QWEN3_ATTN` 환경변수로 어텐션 구현 선택 (`flash_attention_2` 기본, 빌드 실패 시 `sdpa` 자동 폴백)
- 모델 가중치는 `qwen3-models` named volume 에 캐시 (재다운로드 방지, ~4GB)
```

- [ ] **Step 2: 배포 섹션에 Qwen3-TTS 요구사항 추가**

"**배포**" 섹션 하단(`### 자동 시작` 위)에 추가:

```markdown
### GPU 요구사항 (tts-qwen3)
- NVIDIA GPU (RTX 5070 Ti 검증, 16GB VRAM 권장)
- Docker Desktop WSL2 백엔드 + NVIDIA Container Toolkit 설치 필수
- 첫 기동 시 모델 다운로드(~4GB) → 수분 소요. 이후 named volume 캐시로 즉시 기동
- flash-attn 빌드 실패는 비치명(자동 sdpa 폴백). 로그에서 `"flash-attn install failed"` 확인 시 무시 가능
```

- [ ] **Step 3: 커밋**

```bash
git add CLAUDE.md
git commit -m "docs: CLAUDE.md에 tts-qwen3 서비스 + TTS_ENGINE 디스패처 설명"
```

---

## Task 7: 통합 검증 (수동 테스트, 커밋 없음)

**목적:** 실제 시나리오에서 Qwen3 경로가 기존 OpenAI 경로와 동등 이상인지 확인.

- [ ] **Step 1: dev 전체 스택 기동 + warmup**

Run:
```bash
docker compose up -d
until curl -sf http://localhost:81/api/health > /dev/null 2>&1; do sleep 2; done
docker compose exec -T tts-qwen3 curl -X POST http://localhost:8081/warmup
```

Expected: `{"status":"ok","warmup_ms":<수천>}`

- [ ] **Step 2: `/admin/voice-test`에서 5개 페르소나 청취**

각 페르소나별로 다음 문장을 Qwen3 / OpenAI 둘 다 합성 후 비교:

| 페르소나 | 문장 |
|---|---|
| default | 안녕하세요. 오늘은 무엇을 도와드릴까요? |
| interviewer | 자기소개와 함께 가장 자신있는 프로젝트를 소개해주세요. |
| journal_friend | 오늘 하루 어땠어? 뭐 재밌는 일 있었어? |
| journal_counselor | 요즘 어떤 감정을 가장 자주 느끼시는지 천천히 말씀해주세요. |
| tutor | 자, 그럼 이벤트 루프가 어떻게 동작하는지 차근차근 살펴볼까요? |

체크리스트:
- [ ] 한국어 발음 자연스러움 (어색한 억양 없음)
- [ ] 페르소나별 톤 차이 감지됨
- [ ] 잡음/찢김/속도 이상 없음
- [ ] 200자 기준 합성 시간 2초 이내 (어드민 UI의 "생성 Xms" 배지)

- [ ] **Step 3: 실제 기능 리그레션 (Qwen3 엔진 고정)**

임시로 `TTS_ENGINE=qwen3` 전환:
```bash
# backend 컨테이너에 환경변수 주입 (docker-compose override 또는 한시적 수정)
docker compose stop backend
# docker-compose.yml 의 backend environment에 TTS_ENGINE=qwen3 추가 (커밋 안 함)
docker compose up -d backend nginx
```

각 시나리오 1회씩:
- [ ] AI 코치 면접: 질문 1개 이상 듣고 답변 → 오디오 정상 재생
- [ ] 하루의 정리(저널): 1회 메시지 교환 → 오디오 정상 재생
- [ ] 오늘의 학습: 1회 세션 → 오디오 정상 재생

문제없으면 `docker-compose.yml`의 임시 `TTS_ENGINE=qwen3` 되돌리고 backend 재시작.

- [ ] **Step 4: 리그레션 결과 기록**

`docs/tts-benchmark-2026-04-13.md` 와 동일한 위치에 `docs/tts-qwen3-eval-2026-04-15.md` 짧게 작성(별도 커밋 가능):
- 각 페르소나 체감 품질 (상/중/하)
- OpenAI 대비 장단점
- 전환 권장 여부 (Go / No-Go)
- 첫 응답 지연 / 평균 응답 지연 측정값

만족스러우면 후속 작업에서 `TTS_ENGINE=qwen3` 고정 + OpenAI 의존 제거 (이 플랜 밖).

---

## 자기 검토 체크리스트 (작업자용)

작업 완료 후 마지막 확인:

- [ ] `TTS_ENGINE=openai` 기본값으로 기존 동작 보존 (리그레션 없음)
- [ ] `docker compose ps` 에서 tts-qwen3 컨테이너 healthy
- [ ] `nvidia-smi` 로 Qwen3 프로세스 VRAM 점유 확인 (6~8GB 예상)
- [ ] `/admin/voice-test` 엔진 전환 정상
- [ ] 어드민이 아닌 일반 라우트(`POST /api/tts`)는 환경변수 기본값만 따름 (engine 필드 강제 전달 막음 — 실수 방지)
  - 주의: 이 플랜은 `engine` 필드를 `POST /api/tts`에도 허용함. 운영상 민감하면 Task 4 Step 3에서 `engine` 전달을 어드민 전용 엔드포인트로만 제한하는 후속 작업 고려
- [ ] `docker compose down && docker compose up -d` 후 모델 캐시 유지 (named volume 보존 확인)
