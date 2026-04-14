# JD Image Upload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** JD(채용공고) 입력을 이미지 업로드/클립보드 붙여넣기/드래그 앤 드롭으로도 받아, vision LLM으로 텍스트를 추출해 기존 textarea에 누적 append 하는 기능을 추가한다.

**Architecture:** 두 단계 분리. (1) 새 엔드포인트 `POST /api/job-posting/extract-image`가 이미지를 vision LLM으로 평문 추출하여 반환. (2) 유저가 textarea에서 검토/편집 후 기존 `POST /api/job-posting`으로 분석. 추출/분석 프롬프트를 분리해 프롬프트 인젝션 방어.

**Tech Stack:** FastAPI (UploadFile, multipart), OpenAI `gpt-4o-mini` vision (chat.completions + image_url content), Next.js 15 (App Router), React (`onPaste`/`onDrop` 이벤트), shadcn/ui, Tailwind.

**참고 스펙:** `docs/superpowers/specs/2026-04-14-jd-image-upload-design.md`

---

## File Structure

### 수정 / 생성 파일

- **Create**: `backend/tests/test_job_posting_image.py` — `extract_text_from_image` 단위 테스트
- **Modify**: `backend/app/lib/llm_client.py` — `call_llm_vision` 추가
- **Modify**: `backend/app/prompts/job_posting.py` — `JOB_POSTING_IMAGE_EXTRACT_PROMPT` 추가
- **Modify**: `backend/app/services/job_posting.py` — `extract_text_from_image` 추가
- **Modify**: `backend/app/routers/job_posting.py` — `POST /api/job-posting/extract-image` 추가
- **Modify**: `frontend/src/components/job-posting/job-posting-input.tsx` — 이미지 입력 UI + 핸들러

### 변경 영향 없음

- `frontend/src/app/(authenticated)/interview/setup/page.tsx` — `JobPostingInput`만 쓰므로 수정 불필요
- DB 스키마 — 변경 없음
- `POST /api/job-posting` — 변경 없음 (기존 rawText 분석 그대로 재사용)

---

## Task 1: 이미지 추출 프롬프트 추가

**Files:**
- Modify: `backend/app/prompts/job_posting.py`

- [ ] **Step 1: 프롬프트 상수 추가**

`backend/app/prompts/job_posting.py` 파일 끝에 아래 상수를 추가한다. 기존 `JOB_POSTING_ANALYSIS_PROMPT`, `COMPANY_ANALYSIS_PROMPT`는 그대로 둔다.

```python
JOB_POSTING_IMAGE_EXTRACT_PROMPT = """첨부 이미지에서 채용공고 텍스트만 그대로 추출해줘.

## 규칙
- 회사명, 포지션, 자격요건, 우대사항, 기술스택, 복리후생, 근무지 등 본문 텍스트만 추출
- 네비게이션, 버튼, 광고, 아이콘, 장식 텍스트는 제외
- 원본 줄바꿈과 목록 구조는 최대한 유지
- 추출 결과 외에 어떤 설명/머리말/마크다운 코드블록도 출력하지 마라
- 이미지에 읽을 만한 텍스트가 거의 없으면 빈 문자열만 출력
"""
```

- [ ] **Step 2: Commit**

```bash
git add backend/app/prompts/job_posting.py
git commit -m "feat(prompts): JD 이미지 추출 프롬프트 추가"
```

---

## Task 2: `call_llm_vision` 추가

**Files:**
- Modify: `backend/app/lib/llm_client.py`

기존 `call_llm`과 동일 패턴이되, user content를 멀티모달 배열(`text` + `image_url`)로 구성.

- [ ] **Step 1: `call_llm_vision` 함수를 `call_llm_stream` 아래에 추가**

`backend/app/lib/llm_client.py` 파일 끝(118줄 뒤)에 다음 함수를 추가한다.

```python
async def call_llm_vision(
    prompt: str,
    image_data_url: str,
    *,
    model: str | None = None,
    temperature: float = 0.0,
    max_tokens: int = 4096,
    detail: str = "auto",
) -> str:
    """Vision LLM 호출 → 원문 텍스트 반환.

    image_data_url: `data:image/png;base64,...` 형식의 data URL 또는 http(s) URL.
    detail: "low" | "high" | "auto".
    """
    client = _get_client()
    response = await client.chat.completions.create(
        model=model or settings.AGENT_MODEL,
        max_tokens=max_tokens,
        temperature=temperature,
        messages=[
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {
                        "type": "image_url",
                        "image_url": {"url": image_data_url, "detail": detail},
                    },
                ],
            }
        ],
    )
    return response.choices[0].message.content or ""
```

- [ ] **Step 2: Commit**

```bash
git add backend/app/lib/llm_client.py
git commit -m "feat(llm): vision 지원 call_llm_vision 추가"
```

---

## Task 3: `extract_text_from_image` 서비스 — 테스트 먼저

**Files:**
- Create: `backend/tests/test_job_posting_image.py`
- Modify: `backend/app/services/job_posting.py`

서비스 함수는 프롬프트 주입 + `call_llm_vision` 호출 + `.strip()`이 전부. Vision 클라이언트를 monkeypatch로 mock하여 3가지 케이스 검증.

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/test_job_posting_image.py` 파일을 새로 만들어 다음 내용을 작성한다.

```python
"""Unit tests for job posting image extraction service."""
from __future__ import annotations

import pytest

from app.services import job_posting as svc


@pytest.mark.asyncio
async def test_extract_text_from_image_returns_stripped_text(monkeypatch):
    """Vision LLM 응답의 앞뒤 공백을 strip 해서 반환해야 한다."""
    captured: dict = {}

    async def fake_vision(prompt, image_data_url, **kwargs):
        captured["prompt"] = prompt
        captured["image_data_url"] = image_data_url
        captured["kwargs"] = kwargs
        return "\n\n[회사] 백엔드 개발자\n- Java 3년+\n\n"

    monkeypatch.setattr(svc, "call_llm_vision", fake_vision)

    result = await svc.extract_text_from_image("data:image/png;base64,AAA")

    assert result == "[회사] 백엔드 개발자\n- Java 3년+"
    assert captured["image_data_url"] == "data:image/png;base64,AAA"
    assert "채용공고 텍스트" in captured["prompt"]
    # temperature 0.0, detail auto 로 호출되는지 확인
    assert captured["kwargs"].get("temperature") == 0.0
    assert captured["kwargs"].get("detail") == "auto"


@pytest.mark.asyncio
async def test_extract_text_from_image_empty_response(monkeypatch):
    """LLM이 빈 문자열을 반환하면 그대로 빈 문자열 반환."""
    async def fake_vision(prompt, image_data_url, **kwargs):
        return ""

    monkeypatch.setattr(svc, "call_llm_vision", fake_vision)

    result = await svc.extract_text_from_image("data:image/png;base64,AAA")
    assert result == ""


@pytest.mark.asyncio
async def test_extract_text_from_image_propagates_llm_error(monkeypatch):
    """LLM 예외는 그대로 전파되어 라우터가 500으로 처리하게 한다."""
    async def fake_vision(prompt, image_data_url, **kwargs):
        raise RuntimeError("boom")

    monkeypatch.setattr(svc, "call_llm_vision", fake_vision)

    with pytest.raises(RuntimeError, match="boom"):
        await svc.extract_text_from_image("data:image/png;base64,AAA")
```

- [ ] **Step 2: 테스트 실행 — 실패 확인**

백엔드 컨테이너 안에서 실행.

```bash
docker compose exec backend pytest tests/test_job_posting_image.py -v
```

Expected: FAIL — `AttributeError: module 'app.services.job_posting' has no attribute 'extract_text_from_image'` 또는 import error.

- [ ] **Step 3: 서비스 함수 구현**

`backend/app/services/job_posting.py` 의 import 블록 수정 + 함수 추가.

**Import 변경** (파일 상단 `from app.lib.llm_client import call_llm_json, MODELS` 줄):

```python
from app.lib.llm_client import call_llm_json, call_llm_vision, MODELS
```

**Prompts import 변경** (`from app.prompts.job_posting import JOB_POSTING_ANALYSIS_PROMPT, COMPANY_ANALYSIS_PROMPT` 줄):

```python
from app.prompts.job_posting import (
    JOB_POSTING_ANALYSIS_PROMPT,
    COMPANY_ANALYSIS_PROMPT,
    JOB_POSTING_IMAGE_EXTRACT_PROMPT,
)
```

**함수 추가** — 파일 끝 (`_serialize_job_posting` 뒤)에 아래 섹션 추가:

```python
# ---------------------------------------------------------------------------
# Image extraction
# ---------------------------------------------------------------------------

async def extract_text_from_image(image_data_url: str) -> str:
    """Vision LLM으로 이미지에서 JD 평문 텍스트를 추출.

    image_data_url: `data:image/png;base64,...` 형식.
    반환: 추출된 텍스트(strip됨). 이미지에 텍스트가 없으면 빈 문자열.
    """
    text = await call_llm_vision(
        JOB_POSTING_IMAGE_EXTRACT_PROMPT,
        image_data_url,
        model=MODELS["ANALYSIS"],
        temperature=0.0,
        detail="auto",
    )
    return text.strip()
```

- [ ] **Step 4: 테스트 실행 — 통과 확인**

```bash
docker compose exec backend pytest tests/test_job_posting_image.py -v
```

Expected: PASS — 3 tests passed.

- [ ] **Step 5: Commit**

```bash
git add backend/tests/test_job_posting_image.py backend/app/services/job_posting.py
git commit -m "feat(job-posting): 이미지 텍스트 추출 서비스 + 단위 테스트"
```

---

## Task 4: `POST /api/job-posting/extract-image` 라우터

**Files:**
- Modify: `backend/app/routers/job_posting.py`

multipart 파일 검증 로직은 `backend/app/routers/speech.py:84-103` (`/api/transcribe`) 패턴을 그대로 차용. MIME 기반 화이트리스트.

- [ ] **Step 1: 라우터 파일 상단 import 추가**

`backend/app/routers/job_posting.py` 상단 import 블록을 아래로 교체한다(기존 import 유지하고 필요한 것만 추가).

```python
from __future__ import annotations

import base64
import logging

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import AuthUser, get_current_user

logger = logging.getLogger(__name__)

router = APIRouter()

MAX_IMAGE_SIZE = 5 * 1024 * 1024  # 5MB
ALLOWED_IMAGE_MIMES = {"image/png", "image/jpeg", "image/webp"}
```

- [ ] **Step 2: 새 엔드포인트 추가**

기존 `list_job_postings` 함수(파일 끝) 뒤에 아래 엔드포인트를 추가한다.

```python
@router.post("/api/job-posting/extract-image")
async def extract_image_text(
    image: UploadFile = File(...),
    user: AuthUser = Depends(get_current_user),
):
    from app.services.job_posting import extract_text_from_image

    mime = (image.content_type or "").lower()
    if mime not in ALLOWED_IMAGE_MIMES:
        raise HTTPException(
            status_code=400,
            detail={"error": "지원하지 않는 이미지 형식입니다 (png/jpeg/webp)"},
        )

    content = await image.read()
    if len(content) > MAX_IMAGE_SIZE:
        raise HTTPException(
            status_code=413,
            detail={"error": "이미지 크기가 너무 큽니다 (최대 5MB)"},
        )
    if len(content) == 0:
        raise HTTPException(
            status_code=400,
            detail={"error": "빈 이미지 파일입니다"},
        )

    b64 = base64.b64encode(content).decode("ascii")
    data_url = f"data:{mime};base64,{b64}"

    try:
        text = await extract_text_from_image(data_url)
    except Exception:
        logger.exception("Failed to extract text from JD image")
        raise HTTPException(
            status_code=500,
            detail={"error": "텍스트 추출에 실패했습니다"},
        )

    return {"text": text}
```

- [ ] **Step 3: 백엔드 재기동(또는 --reload 확인)**

Dev 컨테이너는 `--reload` + 볼륨 마운트라 자동 반영. 그래도 헬스 체크.

```bash
curl -s http://localhost:81/api/health
```

Expected: `{"status":"ok"}` 또는 동등한 성공 응답.

- [ ] **Step 4: 수동 라우트 확인 — 401 응답 (비인증)**

인증 없이 호출 시 401 나와야 함 (라우트가 등록되었다는 증거).

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:81/api/job-posting/extract-image -F "image=@README.md;type=text/plain"
```

Expected: `401` (get_current_user에 의해 거부).

- [ ] **Step 5: Commit**

```bash
git add backend/app/routers/job_posting.py
git commit -m "feat(api): POST /api/job-posting/extract-image 추가"
```

---

## Task 5: 프론트 — 이미지 입력 UI + 핸들러

**Files:**
- Modify: `frontend/src/components/job-posting/job-posting-input.tsx`

기존 `JobPostingInput` 컴포넌트를 확장. `JobPostingResult`와 `JobPostingInputProps`는 건드리지 않는다.

- [ ] **Step 1: 컴포넌트 전체 교체**

`frontend/src/components/job-posting/job-posting-input.tsx` 의 **`JobPostingInput` 함수만** 아래 내용으로 교체한다. `JobPostingInputProps`, `JobPostingResult`, `JobPostingResultProps` 는 그대로 유지한다.

또한 파일 상단 import에 `useRef`와 `ImagePlus`, `Paperclip` 아이콘을 추가한다.

**Import 블록 교체** (파일 최상단):

```tsx
'use client';

import { useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/useToast';
import { Loader2, CheckCircle, Building2, Paperclip, ImagePlus } from 'lucide-react';
import type { ParsedJobPosting, CompanyAnalysis } from '@/types';
```

**`JobPostingInput` 함수 교체**:

```tsx
const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024;

export function JobPostingInput({ onAnalyzed }: JobPostingInputProps) {
  const [rawText, setRawText] = useState('');
  const [isExtracting, setIsExtracting] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  const analyzeMutation = useMutation({
    mutationFn: async (text: string) => {
      const res = await fetch('/api/job-posting', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rawText: text }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Analysis failed');
      }
      return res.json();
    },
    onSuccess: (data, variables) => {
      onAnalyzed({
        id: data.id,
        rawText: variables,
        parsedData: data.parsedData,
        companyAnalysis: data.companyAnalysis,
      });
      toast({ title: '채용 공고가 분석되었습니다' });
    },
    onError: (error: Error) => {
      toast({ title: '분석 실패', description: error.message, variant: 'destructive' });
    },
  });

  async function handleImageFile(file: File) {
    if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
      toast({
        title: '지원하지 않는 이미지 형식',
        description: 'PNG, JPEG, WebP만 지원합니다',
        variant: 'destructive',
      });
      return;
    }
    if (file.size > MAX_IMAGE_SIZE_BYTES) {
      toast({
        title: '이미지가 너무 큽니다',
        description: '5MB 이하의 이미지만 업로드할 수 있습니다',
        variant: 'destructive',
      });
      return;
    }

    setIsExtracting(true);
    try {
      const formData = new FormData();
      formData.append('image', file);
      const res = await fetch('/api/job-posting/extract-image', {
        method: 'POST',
        body: formData,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error || '텍스트 추출 실패');
      }
      const { text } = (await res.json()) as { text: string };

      if (!text || text.trim().length === 0) {
        toast({
          title: '텍스트를 읽을 수 없습니다',
          description: '다른 이미지를 시도하거나 직접 입력해 주세요',
          variant: 'destructive',
        });
        return;
      }

      setRawText((prev) => (prev.trim().length === 0 ? text : `${prev}\n\n${text}`));
      toast({ title: '텍스트를 추출했습니다' });
    } catch (e) {
      const msg = e instanceof Error ? e.message : '텍스트 추출 실패';
      toast({ title: '추출 실패', description: msg, variant: 'destructive' });
    } finally {
      setIsExtracting(false);
    }
  }

  function handlePaste(e: ClipboardEvent<HTMLDivElement>) {
    if (isExtracting) return;
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) {
          e.preventDefault();
          void handleImageFile(file);
          return;
        }
      }
    }
  }

  function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setIsDragOver(false);
    if (isExtracting) return;
    const file = e.dataTransfer.files?.[0];
    if (file && file.type.startsWith('image/')) {
      void handleImageFile(file);
    }
  }

  return (
    <Card
      onPaste={handlePaste}
      onDragOver={(e) => {
        e.preventDefault();
        setIsDragOver(true);
      }}
      onDragLeave={() => setIsDragOver(false)}
      onDrop={handleDrop}
      className={isDragOver ? 'ring-2 ring-primary' : undefined}
    >
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Building2 className="h-5 w-5" />
          채용 공고 입력
        </CardTitle>
        <CardDescription>
          텍스트를 붙여넣거나, 스크린샷 이미지를 업로드/붙여넣기(Ctrl+V)/드래그할 수 있습니다
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => fileInputRef.current?.click()}
            disabled={isExtracting || analyzeMutation.isPending}
          >
            <Paperclip className="mr-2 h-4 w-4" />
            이미지 파일 선택
          </Button>
          <span className="text-xs text-muted-foreground">
            <ImagePlus className="mr-1 inline h-3.5 w-3.5" />
            Ctrl+V로 스크린샷 붙여넣기 · 드래그 앤 드롭도 가능
          </span>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleImageFile(file);
              e.target.value = '';
            }}
          />
        </div>

        {isExtracting && (
          <div className="flex items-center gap-2 rounded-md bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            이미지에서 텍스트 추출 중...
          </div>
        )}

        <Textarea
          placeholder="채용 공고 텍스트를 여기에 붙여넣으세요...&#10;&#10;예시:&#10;[회사명] 백엔드 개발자 채용&#10;- 자격요건: Java, Spring Boot 경험 3년 이상&#10;- 우대사항: MSA, Docker 경험&#10;..."
          value={rawText}
          onChange={(e) => setRawText(e.target.value)}
          rows={8}
          className="resize-none"
          disabled={isExtracting}
        />
        <Button
          onClick={() => analyzeMutation.mutate(rawText)}
          disabled={rawText.length < 10 || analyzeMutation.isPending || isExtracting}
          className="w-full"
        >
          {analyzeMutation.isPending ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              분석 중...
            </>
          ) : (
            '공고 분석하기'
          )}
        </Button>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 2: 타입 체크 실행**

```bash
cd frontend && npm run typecheck
```

Expected: 0 에러.

- [ ] **Step 3: Lint 실행**

```bash
cd frontend && npm run lint
```

Expected: 0 에러. (경고는 기존 수준 유지)

- [ ] **Step 4: Dev 프론트 리빌드 + 재기동**

```bash
docker compose build frontend && docker compose up -d frontend
```

- [ ] **Step 5: 브라우저 수동 검증**

`http://localhost:81/interview/setup` 접속 → "채용 공고 입력" 카드에서:

1. Win+Shift+S로 화면 일부 캡쳐 → textarea 클릭 후 Ctrl+V → 추출 텍스트가 textarea에 나타남
2. "이미지 파일 선택" → PNG/JPEG 업로드 → 추출 확인
3. 이미지 파일을 카드에 드래그 앤 드롭 → 추출 확인
4. 연속 2번 이미지 붙여넣기 → 두 번째 결과가 기존 뒤에 `\n\n`으로 append 되는지 확인
5. 5MB 초과 이미지 드래그 → toast "이미지가 너무 큽니다" 확인
6. `.gif`/`.bmp` 등 지원 안 하는 이미지 → toast "지원하지 않는 이미지 형식" 확인
7. 추출 중에는 textarea 및 "공고 분석하기" 버튼이 disabled인지 확인
8. 추출된 텍스트로 "공고 분석하기" 버튼 클릭 → 기존 분석 결과 카드 정상 표시

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/job-posting/job-posting-input.tsx
git commit -m "feat(ui): JD 채용공고 이미지 업로드/붙여넣기/드래그 지원"
```

---

## Self-Review Notes

- Spec `docs/superpowers/specs/2026-04-14-jd-image-upload-design.md`의 모든 섹션 커버:
  - UX 투스텝 흐름 ✓ (Task 5)
  - 3가지 입력 수단 (paste/file/drop) ✓ (Task 5)
  - 누적 append ✓ (Task 5 `handleImageFile` 내 `setRawText((prev) => ...)`)
  - 신규 엔드포인트 `/api/job-posting/extract-image` ✓ (Task 4)
  - MIME 화이트리스트/5MB 제한 ✓ (Task 4)
  - 이미지 DB 저장 안 함 ✓ (Task 4에서 저장 로직 없음)
  - `call_llm_vision` 추가 ✓ (Task 2)
  - `JOB_POSTING_IMAGE_EXTRACT_PROMPT` ✓ (Task 1)
  - 추출/분석 프롬프트 분리 ✓ (기존 `/api/job-posting` 미수정)
- 타입/이름 일관성:
  - `extract_text_from_image(image_data_url: str) -> str` — Task 3 정의, Task 4 import 일치
  - 응답 shape `{ "text": string }` — 백엔드 Task 4 / 프론트 Task 5 일치
  - MIME 셋 `{"image/png", "image/jpeg", "image/webp"}` — 백엔드/프론트 동일
  - 5MB 상수 양쪽 모두 명시
