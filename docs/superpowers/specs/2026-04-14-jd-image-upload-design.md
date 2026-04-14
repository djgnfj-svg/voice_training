# JD 이미지 업로드 설계

- 작성일: 2026-04-14
- 범위: 채용공고(JD) 입력에 이미지 업로드/클립보드 붙여넣기 추가
- 대상 아님: 이력서(Resume) — JD 전용

## 배경

현재 `/interview/setup`의 채용공고 입력은 텍스트 붙여넣기만 지원한다. 일부 채용 사이트(LinkedIn, 사람인, 원티드 등)는 드래그/복사를 제한하거나 레이아웃이 복잡해 복붙이 번거롭다. URL 크롤링은 대상 사이트 ToS·차단·유지보수 리스크가 크므로, 유저가 직접 찍은 **스크린샷을 업로드**하는 방식으로 해결한다.

## 목표 / 비목표

- **목표**
  - Win+Shift+S 등으로 클립보드에 담긴 이미지를 `Ctrl+V`로 붙여넣기
  - 파일 선택(버튼) 및 드래그 앤 드롭으로도 업로드 가능
  - 이미지 → 텍스트 추출 결과를 기존 textarea에 **누적 append** (유저가 편집 후 기존 "공고 분석하기" 버튼으로 분석)
- **비목표**
  - 이력서 이미지 업로드 (이번 스코프 아님)
  - 이미지를 JD 파싱 프롬프트에 직접 넣기 (프롬프트 인젝션 리스크 회피)
  - JD 분석 파이프라인 변경 (현재 rawText → parse → company analysis 그대로)

## UX 흐름 (투스텝)

1. 유저가 `/interview/setup`의 채용공고 입력 카드에서:
   - textarea에 커서를 둔 채 `Ctrl+V` (이미지 클립보드) **또는**
   - `📎 파일 선택` 버튼 클릭 → 이미지 파일 선택 **또는**
   - 카드 영역에 이미지 파일 드래그 앤 드롭
2. 프론트가 이미지를 `POST /api/job-posting/extract-image`로 전송
3. 백엔드가 OpenAI vision으로 텍스트 추출 → 평문 반환
4. 프론트가 textarea에 기존 내용 뒤로 `\n\n` + 추출 텍스트 **append**
5. 유저는 textarea 편집 가능 (오인식 보정, 불필요 부분 삭제)
6. 유저가 기존 `공고 분석하기` 버튼 클릭 → 기존 `/api/job-posting` 플로우 그대로 실행

## 컴포넌트 변경: `frontend/src/components/job-posting/job-posting-input.tsx`

- `JobPostingInput` 카드 상단에 입력 수단 UI 추가:
  - 안내 문구: "이미지 붙여넣기(Ctrl+V) · 파일 선택 · 드래그도 가능합니다"
  - 버튼 `📎 이미지 파일 선택` (hidden `<input ref type="file">` 클릭 트리거)
- 카드 컨테이너 `onPaste` / `onDragOver` / `onDrop` 핸들러:
  - `onPaste`: `e.clipboardData.items` 순회, `item.type.startsWith('image/')`인 첫 항목만 `item.getAsFile()`로 추출
  - `onDrop`: `e.preventDefault()` + `e.dataTransfer.files[0]`
- 추출 진행 상태는 로컬 `isExtracting` state. 진행 중엔:
  - textarea `disabled`
  - "분석" 버튼 `disabled`
  - 카드 상단에 `Loader2` + "이미지에서 텍스트 추출 중..." 표시
- 에러:
  - 클라이언트 선차단: 크기 5MB 초과 / 지원 안 하는 MIME → toast
  - 서버 실패 (500/빈 응답) → toast "텍스트 추출 실패. 직접 입력해 주세요"
- 공통 헬퍼 함수 `extractImageToText(file: File): Promise<string>` — 카드 내부 클로저.

## 신규 백엔드 API: `POST /api/job-posting/extract-image`

- 라우터: `backend/app/routers/job_posting.py`
- 인증: 기존과 동일 (`get_current_user`)
- Body: `multipart/form-data`, field `image` (UploadFile)
- 검증:
  - MIME 화이트리스트: `image/png`, `image/jpeg`, `image/webp`
  - 크기 제한: 5MB (바이트 수 확인, 초과 시 413)
  - 확장자는 MIME 기준 (기존 `/api/transcribe` 방식 참고)
- 처리:
  - 파일 바이트 → base64 → data URL (`data:image/png;base64,...`)
  - 서비스 함수 `extract_text_from_image(image_data_url: str) -> str` 호출
- 응답: `{ "text": "..." }`
- 에러:
  - 400: MIME/크기 위반 → `{"error": "지원하지 않는 이미지 형식입니다"}` / `{"error": "이미지 크기가 너무 큽니다 (최대 5MB)"}`
  - 500: 내부 오류 → `{"error": "텍스트 추출에 실패했습니다"}`
  - 빈 결과: 200 + `text: ""` (프론트가 toast로 안내)
- 크레딧 차감 없음 (기존 `/api/job-posting`도 무료)

## 서비스: `backend/app/services/job_posting.py`

- 신규 함수:
  ```python
  async def extract_text_from_image(image_data_url: str) -> str:
      """Vision LLM으로 이미지에서 JD 텍스트 평문 추출."""
  ```
- 구현:
  - `call_llm` (또는 필요시 `call_llm_with_image`) 사용. 현재 `llm_client.py`에 vision 헬퍼가 없으면 최소 범위로 추가 (OpenAI chat.completions에 `image_url` content 지원)
  - 모델: `MODELS["ANALYSIS"]` (기본 `gpt-4o-mini`, vision 지원)
  - `detail: "auto"` (비용/품질 밸런스)
  - `temperature: 0` (추출이므로 결정적)
  - 프롬프트: 아래 신규 상수
  - LLM 응답 문자열을 `.strip()` 후 반환
- 예외: LLM 실패 시 로깅 후 재-raise (라우터에서 500으로 포장)

## 프롬프트: `backend/app/prompts/job_posting.py`

신규 상수 추가:
```
JOB_POSTING_IMAGE_EXTRACT_PROMPT = """첨부 이미지에서 채용공고 텍스트만 그대로 추출해.
- 회사명, 포지션, 자격요건, 우대사항, 기술스택, 복리후생, 근무지 등 본문 텍스트만 추출
- 네비게이션, 버튼, 광고, 아이콘, 장식 텍스트는 제외
- 원본 줄바꿈/목록 구조는 최대한 유지
- 추출 결과 외에 어떤 설명/머리말/마크다운 코드블록도 출력하지 마라
- 이미지에 텍스트가 거의 없으면 빈 문자열만 출력
"""
```

## LLM 클라이언트 확장: `backend/app/lib/llm_client.py`

- 현재 `call_llm` 시그니처는 텍스트 프롬프트 전용. Vision 지원 여부 먼저 확인.
- 없다면 최소 추가:
  ```python
  async def call_llm_vision(
      prompt: str,
      image_data_url: str,
      *,
      model: str,
      temperature: float = 0.0,
      detail: str = "auto",
  ) -> str:
      ...
  ```
  - 내부적으로 OpenAI chat.completions `messages=[{role: "user", content: [{type: "text", ...}, {type: "image_url", image_url: {url, detail}}]}]`
- 기존 `call_llm` 구현 패턴 그대로 따르되 content 배열만 변경.

## 데이터/캐시 영향

- `JobPosting` 테이블 스키마 변경 없음
- 기존 `raw_text_hash` 캐시 그대로. 이미지에서 뽑은 텍스트가 기존 텍스트와 같으면 자동 hit.
- 이미지 자체는 저장하지 않음 (추출 후 즉시 폐기, PII 리스크 감소).

## 보안

- MIME/확장자/크기 서버 검증 (클라이언트 검증만 신뢰 금지)
- 이미지 바이트는 메모리 상에서만 처리 → 파일시스템 저장 없음
- 추출 텍스트는 프롬프트 인젝션 가능성 있음 → **추출 단계와 분석 단계 분리**로 방어 (추출 LLM은 `JOB_POSTING_IMAGE_EXTRACT_PROMPT`만, 분석 LLM은 기존 `JOB_POSTING_ANALYSIS_PROMPT`만. 유저가 중간 textarea에서 검토 가능)

## 테스트

- 백엔드
  - `services/job_posting.extract_text_from_image` 단위: vision 클라이언트 mock → 반환 문자열 그대로 통과 + `.strip()` 확인
  - 라우터 `POST /api/job-posting/extract-image` 통합(mock): 지원 MIME / 초과 크기 / 비지원 MIME 각 케이스 상태코드 확인
- 프론트
  - 수동: Win+Shift+S로 실제 채용공고 스샷 → Ctrl+V → textarea append 확인
  - 수동: 파일 선택, 드래그 앤 드롭 각각 확인
  - 수동: 5MB 초과 파일 → toast 확인
  - 수동: 여러 번 paste → `\n\n` 누적 확인

## 롤아웃 / 리스크

- 기능 플래그 없음 (소규모 UI 추가, 기존 경로 무변경)
- 비용: `gpt-4o-mini` vision 호출 1회/이미지. JD 스샷 1장 `detail: auto` 기준 대략 1~3k 토큰 → 현재 JD 파싱 비용과 유사 수준
- 주요 리스크: vision 오인식(한국어 폰트/복잡 레이아웃). 투스텝 UX로 유저가 검수 가능하므로 허용 가능
