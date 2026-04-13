# Resume RAG Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 이력서를 청크 단위로 임베딩해 RAG로 검색하고, 면접 시작 시 이력서↔JD Fit Analysis로 focus_topics를 추출한 뒤, 매 질문마다 동적 query로 관련 청크를 retrieve해 면접 질문 품질을 끌어올린다.

**Architecture:** 새 테이블 `resume_embeddings`(VECTOR(1536))에 이력서 저장 시 BackgroundTask로 청킹/임베딩. 면접 시작 시 `fit_analyzer` 노드가 skill_match(코드)+focus_topics(LLM) 산출. 매 질문 생성 직전 `search_resume`이 focus_topics 기반 query로 top-3 청크 retrieve. 임베딩 없으면 기존 JSON 통째 fallback.

**Tech Stack:** FastAPI BackgroundTasks, SQLAlchemy raw SQL, pgvector (IVFFLAT), OpenAI `text-embedding-3-small` (배치 호출), `gpt-4o-mini` (`call_llm_json`).

**Spec:** `docs/superpowers/specs/2026-04-13-resume-rag-design.md`

**테스트 정책:** 프로젝트에 pytest 인프라 없음. spec의 "단위 필수"는 `backend/scripts/verify_*.py` 검증 스크립트로 대체 (Docker 컨테이너에서 직접 실행, assert + print). 통합은 수동.

**실행 환경 주의:** 모든 Python 실행은 `docker exec voice_training-backend-1 python ...` 형태. SQL 마이그레이션은 Supabase SQL Editor에서 수행.

---

## 파일 구조 (변경 요약)

**Create:**
- `db/resume_embeddings_migration.sql` — 테이블 + 인덱스
- `db/backfill_resume_embeddings.py` — 기존 이력서 백필 1회용
- `backend/app/agent/resume_rag.py` — `chunk_resume`, `embed_resume_async`, `search_resume`, `has_resume_embeddings`, `_normalize_skill`
- `backend/app/agent/fit_analyzer.py` — `compute_skill_match`, `run_fit_analysis`
- `backend/scripts/verify_chunking.py` — chunk_resume 단위 검증
- `backend/scripts/verify_skill_match.py` — compute_skill_match 단위 검증
- `backend/scripts/verify_resume_rag_e2e.py` — end-to-end 수동 검증

**Modify:**
- `backend/app/agent/state.py` — `fit_analysis`, `current_resume_chunks`, `has_resume_embeddings` 필드 추가
- `backend/app/prompts/agent.py` — `INTERVIEWER_QUESTION_PROMPT` → `_FALLBACK`로 rename, `_SLIM` 추가, `FIT_ANALYSIS_PROMPT` 추가
- `backend/app/agent/interviewer_agent.py` — `generate_question` 시그니처 확장, 분기
- `backend/app/agent/nodes.py` — `fit_analysis_node` 추가, `generate_question` 노드에 `search_resume` hook
- `backend/app/routers/resume.py` — POST/PUT 핸들러에 `BackgroundTasks` 등록
- `backend/app/routers/agent_interview.py` — start 엔드포인트에 fit_analysis 노드 호출

---

## Task 1: DB 마이그레이션 — `resume_embeddings` 테이블

**Files:**
- Create: `db/resume_embeddings_migration.sql`

- [ ] **Step 1: SQL 파일 작성**

```sql
-- db/resume_embeddings_migration.sql
-- 이력서 RAG용 청크 임베딩 테이블
-- pgvector 확장은 user_profile_embeddings 마이그레이션에서 이미 활성화됨

CREATE TABLE IF NOT EXISTS resume_embeddings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "userId" TEXT NOT NULL REFERENCES "users"(id) ON DELETE CASCADE,
    "resumeId" TEXT NOT NULL REFERENCES resumes(id) ON DELETE CASCADE,
    chunk_type VARCHAR(20) NOT NULL CHECK (chunk_type IN ('summary','project','experience','education')),
    chunk_index INT NOT NULL,
    content TEXT NOT NULL,
    embedding VECTOR(1536) NOT NULL,
    metadata JSONB DEFAULT '{}',
    "createdAt" TIMESTAMP(3) DEFAULT NOW(),
    UNIQUE ("resumeId", chunk_type, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_resume_emb_resume ON resume_embeddings ("resumeId");
CREATE INDEX IF NOT EXISTS idx_resume_emb_user ON resume_embeddings ("userId");
CREATE INDEX IF NOT EXISTS idx_resume_emb_vec ON resume_embeddings
    USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
```

- [ ] **Step 2: Supabase SQL Editor에서 실행**

Supabase 대시보드 → SQL Editor → 위 SQL 붙여넣고 Run.
Expected: `Success. No rows returned.`

- [ ] **Step 3: 적용 확인**

`docker exec voice_training-backend-1 python -c "
import asyncio
from sqlalchemy import text
from app.database import async_session

async def main():
    async with async_session() as db:
        r = await db.execute(text(\"SELECT column_name, data_type FROM information_schema.columns WHERE table_name='resume_embeddings' ORDER BY ordinal_position\"))
        for row in r.fetchall():
            print(f'{row.column_name}: {row.data_type}')

asyncio.run(main())
"`

Expected output: id/userId/resumeId/chunk_type/chunk_index/content/embedding/metadata/createdAt 9 컬럼 출력.

- [ ] **Step 4: Commit**

```bash
git add db/resume_embeddings_migration.sql
git commit -m "feat(db): resume_embeddings 테이블 + pgvector 인덱스 추가"
```

---

## Task 2: `chunk_resume` 함수 — 이력서 → 청크 변환

**Files:**
- Create: `backend/app/agent/resume_rag.py`
- Create: `backend/scripts/__init__.py`
- Create: `backend/scripts/verify_chunking.py`

- [ ] **Step 1: scripts 디렉토리 + 초기 모듈 생성**

`backend/scripts/__init__.py` (빈 파일)

`backend/app/agent/resume_rag.py`:
```python
# backend/app/agent/resume_rag.py
"""이력서 RAG: 청킹, 임베딩, 검색."""
from __future__ import annotations

import logging
from typing import TypedDict

logger = logging.getLogger(__name__)


class Chunk(TypedDict):
    chunk_type: str   # 'summary' | 'project' | 'experience' | 'education'
    chunk_index: int
    content: str
    metadata: dict


def _join_nonempty(parts: list[str], sep: str = " | ") -> str:
    """빈 segment 제거 후 join."""
    return sep.join(p for p in parts if p)


def _format_list(values: list, max_items: int = 10) -> str:
    """리스트(achievements/techStack)를 ', '로 join. 빈 값 무시."""
    if not isinstance(values, list):
        return ""
    return ", ".join(str(v).strip() for v in values[:max_items] if str(v).strip())


def chunk_resume(parsed_data: dict | None) -> list[Chunk]:
    """이력서 parsedData를 청크 리스트로 변환.

    Spec D3: summary/project/experience/education만 임베딩. skills 제외.
    각 프로젝트/경력은 description + achievements를 한 청크로 통합 (맥락 보존).
    """
    if not isinstance(parsed_data, dict):
        return []

    chunks: list[Chunk] = []

    # summary
    summary = (parsed_data.get("summary") or "").strip()
    if summary:
        chunks.append({
            "chunk_type": "summary",
            "chunk_index": 0,
            "content": summary,
            "metadata": {"section": "summary"},
        })

    # projects
    projects = parsed_data.get("projects") or []
    if isinstance(projects, list):
        for i, p in enumerate(projects):
            if not isinstance(p, dict):
                continue
            name = (p.get("name") or "").strip()
            period = (p.get("period") or "").strip()
            tech = _format_list(p.get("techStack") or [])
            role = (p.get("role") or "").strip()
            description = (p.get("description") or "").strip()
            achievements = _format_list(p.get("achievements") or [])
            content = _join_nonempty([
                f"[프로젝트] {name}" if name else "",
                period,
                f"기술: {tech}" if tech else "",
                f"역할: {role}" if role else "",
                description,
                f"성과: {achievements}" if achievements else "",
            ])
            if not content:
                continue
            chunks.append({
                "chunk_type": "project",
                "chunk_index": i,
                "content": content,
                "metadata": {
                    "section": "project",
                    "index": i,
                    "name": name,
                    "period": period,
                },
            })

    # experience
    experience = parsed_data.get("experience") or []
    if isinstance(experience, list):
        for i, e in enumerate(experience):
            if not isinstance(e, dict):
                continue
            company = (e.get("company") or "").strip()
            position = (e.get("position") or "").strip()
            period = (e.get("period") or "").strip()
            tech = _format_list(e.get("techStack") or [])
            description = (e.get("description") or "").strip()
            achievements = _format_list(e.get("achievements") or [])
            header = " ".join(s for s in [company, position] if s)
            content = _join_nonempty([
                f"[경력] {header}" if header else "",
                period,
                f"기술: {tech}" if tech else "",
                description,
                f"성과: {achievements}" if achievements else "",
            ])
            if not content:
                continue
            chunks.append({
                "chunk_type": "experience",
                "chunk_index": i,
                "content": content,
                "metadata": {
                    "section": "experience",
                    "index": i,
                    "company": company,
                    "period": period,
                },
            })

    # education
    education = parsed_data.get("education") or []
    if isinstance(education, list):
        for i, ed in enumerate(education):
            if not isinstance(ed, dict):
                continue
            school = (ed.get("school") or "").strip()
            major = (ed.get("major") or "").strip()
            degree = (ed.get("degree") or "").strip()
            period = (ed.get("period") or "").strip()
            gpa = ed.get("gpa")
            header = " ".join(s for s in [school, major, degree] if s)
            content = _join_nonempty([
                f"[학력] {header}" if header else "",
                period,
                f"GPA {gpa}" if gpa not in (None, "", 0) else "",
            ])
            if not content:
                continue
            chunks.append({
                "chunk_type": "education",
                "chunk_index": i,
                "content": content,
                "metadata": {
                    "section": "education",
                    "index": i,
                    "school": school,
                },
            })

    return chunks
```

- [ ] **Step 2: 검증 스크립트 작성**

`backend/scripts/verify_chunking.py`:
```python
"""chunk_resume 단위 검증.

실행: docker exec voice_training-backend-1 python -m scripts.verify_chunking
"""
from __future__ import annotations

from app.agent.resume_rag import chunk_resume


def test_full_resume():
    data = {
        "name": "홍길동",
        "summary": "백엔드 3년차, FastAPI 전문",
        "skills": ["Python", "FastAPI"],
        "projects": [
            {
                "name": "쇼핑몰",
                "period": "2023.01~2023.06",
                "techStack": ["Next.js", "Stripe"],
                "role": "백엔드",
                "description": "결제 플로우 설계",
                "achievements": ["장애율 80% 감소"],
            }
        ],
        "experience": [
            {
                "company": "네이버",
                "position": "백엔드",
                "period": "2021.03~2024.02",
                "techStack": ["Python"],
                "description": "추천 서비스",
                "achievements": ["처리량 2배"],
            }
        ],
        "education": [{"school": "서울대", "major": "컴공", "degree": "학사", "period": "2017~2021", "gpa": 4.1}],
    }
    chunks = chunk_resume(data)
    types = [c["chunk_type"] for c in chunks]
    assert types == ["summary", "project", "experience", "education"], f"types={types}"
    assert "[프로젝트] 쇼핑몰" in chunks[1]["content"]
    assert "장애율 80% 감소" in chunks[1]["content"]
    assert "[경력] 네이버 백엔드" in chunks[2]["content"]
    assert "GPA 4.1" in chunks[3]["content"]
    assert chunks[1]["metadata"]["name"] == "쇼핑몰"
    print("test_full_resume PASS")


def test_summary_only():
    data = {"summary": "신입 개발자, React 학습 중"}
    chunks = chunk_resume(data)
    assert len(chunks) == 1
    assert chunks[0]["chunk_type"] == "summary"
    assert chunks[0]["content"] == "신입 개발자, React 학습 중"
    print("test_summary_only PASS")


def test_empty():
    assert chunk_resume(None) == []
    assert chunk_resume({}) == []
    assert chunk_resume({"skills": ["A"], "summary": ""}) == []
    print("test_empty PASS")


def test_skills_excluded():
    data = {"skills": ["React", "Vue"], "summary": "프론트엔드"}
    chunks = chunk_resume(data)
    types = [c["chunk_type"] for c in chunks]
    assert "skill" not in types and "skills" not in types
    print("test_skills_excluded PASS")


def test_partial_project():
    data = {"projects": [{"name": "X", "description": ""}, {"description": "Y만 있음"}]}
    chunks = chunk_resume(data)
    assert len(chunks) == 2, f"len={len(chunks)}"
    assert "[프로젝트] X" in chunks[0]["content"]
    assert "Y만 있음" in chunks[1]["content"]
    print("test_partial_project PASS")


if __name__ == "__main__":
    test_full_resume()
    test_summary_only()
    test_empty()
    test_skills_excluded()
    test_partial_project()
    print("\nALL PASS")
```

- [ ] **Step 3: 검증 실행**

```
docker exec voice_training-backend-1 python -m scripts.verify_chunking
```
Expected: 5개 PASS + `ALL PASS`

- [ ] **Step 4: Commit**

```bash
git add backend/app/agent/resume_rag.py backend/scripts/__init__.py backend/scripts/verify_chunking.py
git commit -m "feat(agent): chunk_resume — 이력서 청킹 함수 + 검증 스크립트"
```

---

## Task 3: 임베딩 + DB 함수 — `embed_resume_async`, `search_resume`, `has_resume_embeddings`

**Files:**
- Modify: `backend/app/agent/resume_rag.py`

- [ ] **Step 1: 임베딩/DB 함수 추가**

`backend/app/agent/resume_rag.py` 끝에 추가:
```python
import json
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.embeddings import _get_openai_client, EMBEDDING_MODEL
from app.database import async_session


async def _embed_batch(contents: list[str]) -> list[list[float]]:
    """OpenAI 배치 임베딩 (1회 호출)."""
    client = _get_openai_client()
    response = await client.embeddings.create(model=EMBEDDING_MODEL, input=contents)
    return [d.embedding for d in response.data]


def _vec_str(v: list[float]) -> str:
    return "[" + ",".join(str(x) for x in v) + "]"


async def has_resume_embeddings(db: AsyncSession, resume_id: str) -> bool:
    r = await db.execute(
        text('SELECT 1 FROM resume_embeddings WHERE "resumeId" = :rid LIMIT 1'),
        {"rid": resume_id},
    )
    return r.fetchone() is not None


async def embed_resume(resume_id: str, user_id: str, parsed_data: dict | None) -> int:
    """청킹 → 배치 임베딩 → 전량 교체. BackgroundTask로 호출되며 자체 세션 사용.

    Returns: 저장된 청크 개수.
    """
    chunks = chunk_resume(parsed_data)
    async with async_session() as db:
        try:
            # 전량 교체
            await db.execute(
                text('DELETE FROM resume_embeddings WHERE "resumeId" = :rid'),
                {"rid": resume_id},
            )
            if not chunks:
                await db.commit()
                logger.info("embed_resume: no chunks for resume_id=%s", resume_id)
                return 0

            embeddings = await _embed_batch([c["content"] for c in chunks])

            for chunk, emb in zip(chunks, embeddings):
                await db.execute(
                    text("""
                        INSERT INTO resume_embeddings
                            (id, "userId", "resumeId", chunk_type, chunk_index, content, embedding, metadata)
                        VALUES
                            (gen_random_uuid(), :uid, :rid, :ctype, :cidx, :content, CAST(:emb AS vector), :meta)
                    """),
                    {
                        "uid": user_id,
                        "rid": resume_id,
                        "ctype": chunk["chunk_type"],
                        "cidx": chunk["chunk_index"],
                        "content": chunk["content"],
                        "emb": _vec_str(emb),
                        "meta": json.dumps(chunk["metadata"]),
                    },
                )
            await db.commit()
            logger.info("embed_resume: stored %d chunks for resume_id=%s", len(chunks), resume_id)
            return len(chunks)
        except Exception:
            await db.rollback()
            logger.exception("embed_resume failed: resume_id=%s", resume_id)
            return 0


async def search_resume(
    db: AsyncSession,
    user_id: str,
    resume_id: str,
    query: str,
    top_k: int = 3,
) -> list[dict]:
    """이력서 청크 코사인 유사도 검색."""
    if not query or not query.strip():
        return []
    client = _get_openai_client()
    emb = (await client.embeddings.create(model=EMBEDDING_MODEL, input=query)).data[0].embedding
    r = await db.execute(
        text("""
            SELECT chunk_type, chunk_index, content, metadata,
                   1 - (embedding <=> CAST(:emb AS vector)) AS similarity
            FROM resume_embeddings
            WHERE "userId" = :uid AND "resumeId" = :rid
            ORDER BY embedding <=> CAST(:emb AS vector)
            LIMIT :k
        """),
        {"uid": user_id, "rid": resume_id, "emb": _vec_str(emb), "k": top_k},
    )
    return [
        {
            "chunk_type": row.chunk_type,
            "chunk_index": row.chunk_index,
            "content": row.content,
            "metadata": row.metadata,
            "similarity": round(row.similarity, 4),
        }
        for row in r.fetchall()
    ]
```

- [ ] **Step 2: import 누락 점검**

파일 상단 import 블록 정리 — 위 스니펫의 `import json` 등은 파일 상단으로 이동. 최종 import 블록:
```python
from __future__ import annotations

import json
import logging
from typing import TypedDict

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.embeddings import _get_openai_client, EMBEDDING_MODEL
from app.database import async_session
```

- [ ] **Step 3: 임베딩 round-trip 검증**

테스트 계정의 이력서로 즉석 임베딩 후 검색:
```
docker exec voice_training-backend-1 python -c "
import asyncio
from sqlalchemy import text
from app.database import async_session
from app.agent.resume_rag import embed_resume, search_resume, has_resume_embeddings

async def main():
    async with async_session() as db:
        r = await db.execute(text('SELECT id, \"userId\", \"parsedData\" FROM resumes LIMIT 1'))
        row = r.fetchone()
        if not row:
            print('no resume in DB'); return
        rid, uid, pd = row.id, row.userId, row.parsedData
        print(f'target resume: {rid[:8]}')

    n = await embed_resume(rid, uid, pd)
    print(f'embedded chunks: {n}')

    async with async_session() as db:
        assert await has_resume_embeddings(db, rid), 'has_resume_embeddings should be True'
        results = await search_resume(db, uid, rid, '주요 프로젝트 경험', top_k=3)
        for r in results:
            print(f'  [{r[\"chunk_type\"]} sim={r[\"similarity\"]}] {r[\"content\"][:80]}')
    print('PASS')

asyncio.run(main())
"
```
Expected: `embedded chunks: N` (N>=1), top_k 결과 출력, `PASS`.

- [ ] **Step 4: Commit**

```bash
git add backend/app/agent/resume_rag.py
git commit -m "feat(agent): embed_resume/search_resume/has_resume_embeddings — pgvector RAG 함수"
```

---

## Task 4: `compute_skill_match` — 결정적 스킬 매칭

**Files:**
- Create: `backend/app/agent/fit_analyzer.py`
- Create: `backend/scripts/verify_skill_match.py`

- [ ] **Step 1: fit_analyzer.py 작성 (스킬 매칭만 우선)**

```python
# backend/app/agent/fit_analyzer.py
"""Fit Analysis: 이력서↔JD 매칭. skill_match는 코드, focus_topics는 LLM."""
from __future__ import annotations

import json
import logging
from typing import TypedDict

from app.config import settings
from app.lib.llm_client import call_llm_json

logger = logging.getLogger(__name__)


class SkillMatch(TypedDict):
    matched: list[str]
    gap: list[str]
    coverage: float


class FocusTopic(TypedDict):
    topic: str
    why: str
    priority: str  # 'high' | 'medium' | 'low'


class FitAnalysis(TypedDict):
    skill_match: SkillMatch | None
    focus_topics: list[FocusTopic]
    avoid_topics: list[str]


def _normalize_skill(s: str) -> str:
    """대소문자/구분자 차이 흡수. 'Next.js'/'NextJS'/'next js' → 'nextjs'."""
    if not isinstance(s, str):
        return ""
    return s.lower().replace(".", "").replace("-", "").replace(" ", "").strip()


def _extract_jd_skills(jd: dict | None) -> list[str]:
    """JD parsedData에서 요구 스킬 리스트 추출. 다양한 키를 시도."""
    if not isinstance(jd, dict):
        return []
    for key in ("requiredSkills", "skills", "required", "techStack"):
        v = jd.get(key)
        if isinstance(v, list) and v:
            return [str(s) for s in v if s]
    return []


def compute_skill_match(resume_skills: list, jd_skills: list) -> SkillMatch | None:
    """JD가 비어있으면 None. 정규화 키로 비교, 표시는 JD 원문 우선."""
    if not jd_skills:
        return None

    resume_keys = {_normalize_skill(s): str(s) for s in (resume_skills or []) if s}
    matched_display: list[str] = []
    gap_display: list[str] = []
    for s in jd_skills:
        k = _normalize_skill(s)
        if not k:
            continue
        if k in resume_keys:
            matched_display.append(str(s))
        else:
            gap_display.append(str(s))

    total = len(matched_display) + len(gap_display)
    coverage = (len(matched_display) / total) if total else 0.0
    return {
        "matched": matched_display,
        "gap": gap_display,
        "coverage": round(coverage, 3),
    }
```

- [ ] **Step 2: 검증 스크립트 작성**

`backend/scripts/verify_skill_match.py`:
```python
"""compute_skill_match 단위 검증.

실행: docker exec voice_training-backend-1 python -m scripts.verify_skill_match
"""
from app.agent.fit_analyzer import compute_skill_match, _normalize_skill, _extract_jd_skills


def test_normalize():
    assert _normalize_skill("Next.js") == "nextjs"
    assert _normalize_skill("NextJS") == "nextjs"
    assert _normalize_skill("next js") == "nextjs"
    assert _normalize_skill("react-native") == "reactnative"
    assert _normalize_skill("") == ""
    print("test_normalize PASS")


def test_match_basic():
    m = compute_skill_match(["React", "TypeScript", "Node.js"], ["react", "GraphQL", "Node JS"])
    assert "react" in m["matched"], m
    assert "Node JS" in m["matched"], m
    assert "GraphQL" in m["gap"], m
    assert m["coverage"] == round(2/3, 3), m
    print("test_match_basic PASS")


def test_no_jd():
    assert compute_skill_match(["React"], []) is None
    print("test_no_jd PASS")


def test_full_match():
    m = compute_skill_match(["React"], ["React"])
    assert m["coverage"] == 1.0
    assert m["gap"] == []
    print("test_full_match PASS")


def test_full_gap():
    m = compute_skill_match([], ["React"])
    assert m["coverage"] == 0.0
    assert m["matched"] == []
    print("test_full_gap PASS")


def test_extract_jd_skills():
    assert _extract_jd_skills({"requiredSkills": ["A"]}) == ["A"]
    assert _extract_jd_skills({"techStack": ["B"]}) == ["B"]
    assert _extract_jd_skills(None) == []
    assert _extract_jd_skills({}) == []
    print("test_extract_jd_skills PASS")


if __name__ == "__main__":
    test_normalize()
    test_match_basic()
    test_no_jd()
    test_full_match()
    test_full_gap()
    test_extract_jd_skills()
    print("\nALL PASS")
```

- [ ] **Step 3: 검증 실행**

```
docker exec voice_training-backend-1 python -m scripts.verify_skill_match
```
Expected: 6개 PASS + `ALL PASS`

- [ ] **Step 4: Commit**

```bash
git add backend/app/agent/fit_analyzer.py backend/scripts/verify_skill_match.py
git commit -m "feat(agent): compute_skill_match — 정규화 기반 결정적 스킬 매칭"
```

---

## Task 5: `FIT_ANALYSIS_PROMPT` + `run_fit_analysis` — LLM 매칭 분석

**Files:**
- Modify: `backend/app/prompts/agent.py`
- Modify: `backend/app/agent/fit_analyzer.py`

- [ ] **Step 1: 프롬프트 추가**

`backend/app/prompts/agent.py` 끝에 추가:
```python

FIT_ANALYSIS_PROMPT = """당신은 면접 설계 전문가입니다. 지원자의 이력서와 채용공고를 비교하여, 면접관이 깊이 파볼 만한 주제(focus_topics)와 다루지 말아야 할 주제(avoid_topics)를 추출하세요.

<resume>
{resume_brief}
</resume>

<job_posting>
{jd_brief}
</job_posting>

<skill_match>
matched(이력서·JD 둘 다 있음): {matched}
gap(JD 요구이나 이력서 미언급): {gap}
</skill_match>

다음 JSON 형식으로 반환하세요:
{{
  "focus_topics": [
    {{"topic": "주제명", "why": "선택 이유 한 줄", "priority": "high|medium|low"}}
  ],
  "avoid_topics": ["피할 주제 1"]
}}

규칙:
- focus_topics 3~5개. JD의 핵심 요구사항 + 이력서 강점 영역을 우선
- gap 영역은 "기초 탐색" 차원에서 1개 이내만 포함
- avoid_topics는 0~3개. 이력서 수준 대비 너무 낮거나 본질에서 벗어난 주제
- 채용공고가 없으면 이력서 기반 강점/관심 영역으로만 작성
"""
```

- [ ] **Step 2: `run_fit_analysis` 함수 추가**

`backend/app/agent/fit_analyzer.py` 끝에 추가:
```python
def _summarize_resume(resume: dict | None) -> str:
    """LLM 토큰 절약용 요약."""
    if not isinstance(resume, dict):
        return "이력서 없음"
    parts = []
    if s := resume.get("summary"):
        parts.append(f"summary: {s}")
    if skills := resume.get("skills"):
        parts.append(f"skills: {', '.join(str(x) for x in skills[:20])}")
    projects = resume.get("projects") or []
    for p in projects[:5]:
        if not isinstance(p, dict):
            continue
        name = p.get("name", "")
        tech = ", ".join(str(t) for t in (p.get("techStack") or [])[:5])
        desc = (p.get("description") or "")[:80]
        parts.append(f"- 프로젝트: {name} ({tech}) — {desc}")
    experience = resume.get("experience") or []
    for e in experience[:3]:
        if not isinstance(e, dict):
            continue
        parts.append(f"- 경력: {e.get('company','')} {e.get('position','')} ({e.get('period','')})")
    return "\n".join(parts) or "이력서 정보 없음"


def _summarize_jd(jd: dict | None) -> str:
    if not isinstance(jd, dict):
        return "채용공고 없음"
    parts = []
    if pos := jd.get("position"):
        parts.append(f"position: {pos}")
    if comp := jd.get("company"):
        parts.append(f"company: {comp}")
    if reqs := jd.get("requirements"):
        if isinstance(reqs, list):
            parts.append("requirements:\n" + "\n".join(f"- {r}" for r in reqs[:10]))
        else:
            parts.append(f"requirements: {reqs}")
    if resp := jd.get("responsibilities"):
        if isinstance(resp, list):
            parts.append("responsibilities:\n" + "\n".join(f"- {r}" for r in resp[:10]))
    return "\n".join(parts) or "채용공고 정보 없음"


async def run_fit_analysis(resume: dict | None, jd: dict | None) -> FitAnalysis:
    """이력서↔JD Fit Analysis. skill_match는 코드, focus/avoid는 LLM.

    LLM 실패 시 focus_topics/avoid_topics만 빈 배열로, skill_match는 반환.
    """
    from app.prompts.agent import FIT_ANALYSIS_PROMPT

    resume_skills = (resume or {}).get("skills") or []
    jd_skills = _extract_jd_skills(jd)
    skill_match = compute_skill_match(resume_skills, jd_skills)

    prompt = FIT_ANALYSIS_PROMPT.format(
        resume_brief=_summarize_resume(resume),
        jd_brief=_summarize_jd(jd),
        matched=", ".join(skill_match["matched"]) if skill_match else "(JD 없음)",
        gap=", ".join(skill_match["gap"]) if skill_match else "(JD 없음)",
    )

    focus_topics: list[FocusTopic] = []
    avoid_topics: list[str] = []
    try:
        result = await call_llm_json(prompt, model=settings.AGENT_MODEL, temperature=0.4)
        raw_topics = result.get("focus_topics") or []
        for t in raw_topics[:5]:
            if not isinstance(t, dict):
                continue
            topic = (t.get("topic") or "").strip()
            if not topic:
                continue
            focus_topics.append({
                "topic": topic,
                "why": (t.get("why") or "").strip(),
                "priority": t.get("priority") if t.get("priority") in ("high", "medium", "low") else "medium",
            })
        raw_avoid = result.get("avoid_topics") or []
        avoid_topics = [str(s).strip() for s in raw_avoid[:3] if str(s).strip()]
    except Exception:
        logger.exception("fit_analysis LLM call failed")

    return {
        "skill_match": skill_match,
        "focus_topics": focus_topics,
        "avoid_topics": avoid_topics,
    }
```

- [ ] **Step 3: 검증 (실 LLM 호출 1회)**

```
docker exec voice_training-backend-1 python -c "
import asyncio
from app.agent.fit_analyzer import run_fit_analysis

resume = {
    'summary': '백엔드 3년차',
    'skills': ['Python', 'FastAPI', 'PostgreSQL'],
    'projects': [{'name': '결제 시스템', 'techStack': ['Python', 'Stripe'], 'description': 'Stripe 연동 및 장애 대응'}],
}
jd = {
    'position': '시니어 백엔드',
    'requiredSkills': ['Python', 'Kubernetes', 'GraphQL'],
    'requirements': ['k8s 운영 경험', 'GraphQL API 설계'],
}

async def main():
    fa = await run_fit_analysis(resume, jd)
    print('skill_match:', fa['skill_match'])
    print('focus_topics:')
    for t in fa['focus_topics']:
        print(f'  - [{t[\"priority\"]}] {t[\"topic\"]} — {t[\"why\"]}')
    print('avoid_topics:', fa['avoid_topics'])
    assert fa['skill_match']['coverage'] > 0
    assert len(fa['focus_topics']) >= 1, 'expect non-empty focus_topics'
    print('PASS')

asyncio.run(main())
"
```
Expected: skill_match에 Python matched, k8s/GraphQL gap, focus_topics 1개 이상, `PASS`.

- [ ] **Step 4: Commit**

```bash
git add backend/app/prompts/agent.py backend/app/agent/fit_analyzer.py
git commit -m "feat(agent): run_fit_analysis + FIT_ANALYSIS_PROMPT — 이력서↔JD LLM 매칭"
```

---

## Task 6: `state.py` 필드 확장

**Files:**
- Modify: `backend/app/agent/state.py`

- [ ] **Step 1: 필드 추가**

기존 `InterviewState` TypedDict 끝에 추가:
```python
    # Fit Analysis (시작 시 1회 산출)
    fit_analysis: dict | None  # FitAnalysis: skill_match + focus_topics + avoid_topics

    # 이력서 RAG
    has_resume_embeddings: bool
    current_resume_chunks: list[dict]  # 매 질문 직전 갱신, top_k=3
    resume_id: str | None  # search_resume에 필요
```

- [ ] **Step 2: import/구문 검증**

```
docker exec voice_training-backend-1 python -c "from app.agent.state import InterviewState; print('ok', list(InterviewState.__annotations__.keys()))"
```
Expected: `ok ['session_id', 'user_id', ..., 'fit_analysis', 'has_resume_embeddings', 'current_resume_chunks', 'resume_id']`

- [ ] **Step 3: Commit**

```bash
git add backend/app/agent/state.py
git commit -m "feat(agent): InterviewState에 fit_analysis/has_resume_embeddings/current_resume_chunks/resume_id 추가"
```

---

## Task 7: 프롬프트 분리 — `_FALLBACK` rename + `_SLIM` 추가

**Files:**
- Modify: `backend/app/prompts/agent.py`

- [ ] **Step 1: 기존 `INTERVIEWER_QUESTION_PROMPT` 본문 확인**

```
docker exec voice_training-backend-1 python -c "from app.prompts.agent import INTERVIEWER_QUESTION_PROMPT; print(INTERVIEWER_QUESTION_PROMPT)"
```
출력 내용을 그대로 보존하면서 rename할 것.

- [ ] **Step 2: rename + 신규 프롬프트 추가**

`backend/app/prompts/agent.py`:
- `INTERVIEWER_QUESTION_PROMPT = """..."""` → `INTERVIEWER_QUESTION_PROMPT_FALLBACK = """..."""` (rename only, body 동일)
- 추가:
```python

INTERVIEWER_QUESTION_PROMPT_SLIM = """당신은 숙련된 기술 면접관입니다. 다음 정보를 바탕으로 다음 질문 1개를 생성하세요.

<지원자 요약>
{summary}
</지원자 요약>

<보유 기술>
{skills}
</보유 기술>

<관련 이력서 발췌 (RAG 검색 결과)>
{resume_chunks}
</관련 이력서 발췌>

<채용공고>
{job_posting}
</채용공고>

<Fit Analysis>
{fit_analysis}
</Fit Analysis>

<누적 프로필 인사이트>
강점: {strengths}
약점: {weaknesses}
패턴: {patterns}
</누적 프로필 인사이트>

<현재까지 대화>
{conversation_history}
</현재까지 대화>

지시사항:
- 이번 질문은 Fit Analysis의 focus_topic "{current_focus_topic}"을 다루세요. focus_topic이 비어있으면 이력서 발췌의 첫 청크 주제를 다루세요.
- avoid_topics는 피하세요: {avoid_topics}
- 다음 JSON 형식으로만 반환:
{{
  "question": "면접 질문 본문",
  "targetArea": "다루는 영역 (예: 상태관리, 시스템 설계)",
  "difficulty": "easy|medium|hard"
}}
"""
```

- [ ] **Step 3: 기존 import 호환성 확인**

`grep -rn "INTERVIEWER_QUESTION_PROMPT" backend/app` — `_FALLBACK` 외 다른 import 있으면 모두 `_FALLBACK`으로 수정.

```
docker exec voice_training-backend-1 grep -rn "INTERVIEWER_QUESTION_PROMPT" /app/app
```
Expected: import 라인이 `INTERVIEWER_QUESTION_PROMPT_FALLBACK` 또는 `INTERVIEWER_QUESTION_PROMPT_SLIM`만 있어야 함.

- [ ] **Step 4: import 검증**

```
docker exec voice_training-backend-1 python -c "from app.prompts.agent import INTERVIEWER_QUESTION_PROMPT_SLIM, INTERVIEWER_QUESTION_PROMPT_FALLBACK, FIT_ANALYSIS_PROMPT; print('ok')"
```
Expected: `ok`

- [ ] **Step 5: Commit**

```bash
git add backend/app/prompts/agent.py
git commit -m "feat(prompts): INTERVIEWER_QUESTION_PROMPT_SLIM + _FALLBACK 분리"
```

---

## Task 8: `interviewer_agent.generate_question` 시그니처 확장 + 분기

**Files:**
- Modify: `backend/app/agent/interviewer_agent.py`

- [ ] **Step 1: 시그니처/분기 변경**

`generate_question` 함수 전체 교체:
```python
async def generate_question(
    resume: dict,
    job_posting: dict | None,
    user_profile: dict,
    conversation_history: list[dict],
    fit_analysis: dict | None = None,
    resume_chunks: list[dict] | None = None,
    has_embeddings: bool = False,
    current_focus_topic: str = "",
) -> dict:
    """면접 질문 생성. has_embeddings에 따라 SLIM/FALLBACK 분기."""
    profile_str = _format_profile(user_profile)
    history_str = _format_history(conversation_history)
    job_str = json.dumps(job_posting, ensure_ascii=False, indent=2) if job_posting else "채용공고 없음"

    if has_embeddings and resume_chunks:
        from app.prompts.agent import INTERVIEWER_QUESTION_PROMPT_SLIM
        chunks_str = "\n\n".join(c.get("content", "") for c in resume_chunks)
        fit_str = json.dumps(fit_analysis, ensure_ascii=False, indent=2) if fit_analysis else "Fit Analysis 없음"
        avoid_str = ", ".join((fit_analysis or {}).get("avoid_topics", [])) or "(없음)"
        prompt = INTERVIEWER_QUESTION_PROMPT_SLIM.format(
            summary=resume.get("summary", "") if isinstance(resume, dict) else "",
            skills=", ".join(str(s) for s in (resume.get("skills") or [])) if isinstance(resume, dict) else "",
            resume_chunks=chunks_str,
            job_posting=job_str,
            fit_analysis=fit_str,
            strengths=profile_str["strengths"],
            weaknesses=profile_str["weaknesses"],
            patterns=profile_str["patterns"],
            conversation_history=history_str,
            current_focus_topic=current_focus_topic or "(자유 선택)",
            avoid_topics=avoid_str,
        )
    else:
        from app.prompts.agent import INTERVIEWER_QUESTION_PROMPT_FALLBACK
        resume_str = json.dumps(resume, ensure_ascii=False, indent=2) if isinstance(resume, dict) else str(resume)
        prompt = INTERVIEWER_QUESTION_PROMPT_FALLBACK.format(
            resume=resume_str,
            job_posting=job_str,
            strengths=profile_str["strengths"],
            weaknesses=profile_str["weaknesses"],
            patterns=profile_str["patterns"],
            context=profile_str["context"],
            conversation_history=history_str,
        )

    return await call_llm_json(prompt, model=settings.AGENT_MODEL, temperature=0.7)
```

- [ ] **Step 2: import 정리**

기존 `from app.prompts.agent import INTERVIEWER_QUESTION_PROMPT, ...` 라인에서 `INTERVIEWER_QUESTION_PROMPT` 제거 (위에서 함수 내 lazy import로 옮김). 다른 PROMPT는 유지.

- [ ] **Step 3: 모듈 import 검증**

```
docker exec voice_training-backend-1 python -c "from app.agent.interviewer_agent import generate_question; import inspect; print(list(inspect.signature(generate_question).parameters.keys()))"
```
Expected: `['resume', 'job_posting', 'user_profile', 'conversation_history', 'fit_analysis', 'resume_chunks', 'has_embeddings', 'current_focus_topic']`

- [ ] **Step 4: Commit**

```bash
git add backend/app/agent/interviewer_agent.py
git commit -m "feat(agent): generate_question — has_embeddings 분기 + SLIM/FALLBACK 프롬프트 호출"
```

---

## Task 9: `nodes.py` — `fit_analysis_node` 추가 + `generate_question` 노드 RAG hook

**Files:**
- Modify: `backend/app/agent/nodes.py`

- [ ] **Step 1: imports 보강**

파일 상단에 추가:
```python
from app.agent import resume_rag, fit_analyzer
```

- [ ] **Step 2: `fit_analysis_node` 신규 함수 추가**

`load_profile` 함수 바로 아래에 추가:
```python
async def fit_analysis_node(state: InterviewState, db: AsyncSession) -> InterviewState:
    """이력서↔JD Fit Analysis. 면접 시작 시 1회 호출."""
    events = list(state.get("pending_events", []))
    events.append({"event": "status", "data": {"phase": "fit_analyzing"}})

    fa = await fit_analyzer.run_fit_analysis(state["resume"], state.get("job_posting"))

    has_emb = False
    rid = state.get("resume_id")
    if rid:
        has_emb = await resume_rag.has_resume_embeddings(db, rid)

    events.append({
        "event": "status",
        "data": {
            "phase": "fit_analyzed",
            "focus_topics_count": len(fa["focus_topics"]),
            "has_resume_embeddings": has_emb,
        },
    })

    return {
        **state,
        "fit_analysis": fa,
        "has_resume_embeddings": has_emb,
        "current_resume_chunks": [],
        "pending_events": events,
    }
```

- [ ] **Step 3: `generate_question` 노드에 search_resume hook 추가**

기존 `generate_question` (nodes.py:121) 함수 본문을 다음으로 교체:
```python
async def generate_question(state: InterviewState, db: AsyncSession) -> InterviewState:
    """Generate next interview question. RAG 검색 후 SLIM/FALLBACK 분기."""
    events = list(state.get("pending_events", []))
    events.append({"event": "status", "data": {"phase": "generating_question"}})

    # 1) 검색 query 산출 (Spec D5)
    fa = state.get("fit_analysis") or {}
    focus_topics = fa.get("focus_topics") or []
    i = state.get("question_count", 0)
    current_focus_topic = ""
    if focus_topics:
        ft = focus_topics[i % len(focus_topics)]
        current_focus_topic = ft.get("topic", "")
    query = current_focus_topic or state.get("current_answer") or (state["resume"] or {}).get("summary") or "주요 경험"

    # 2) RAG 검색
    chunks: list[dict] = []
    has_emb = state.get("has_resume_embeddings", False)
    rid = state.get("resume_id")
    if has_emb and rid:
        try:
            chunks = await resume_rag.search_resume(db, state["user_id"], rid, query, top_k=3)
        except Exception:
            logger.exception("search_resume failed; falling back to no chunks")
            chunks = []

    # 3) 질문 생성
    result = await interviewer_agent.generate_question(
        resume=state["resume"],
        job_posting=state.get("job_posting"),
        user_profile=state["user_profile"],
        conversation_history=state.get("conversation_history", []),
        fit_analysis=fa or None,
        resume_chunks=chunks,
        has_embeddings=has_emb and bool(chunks),
        current_focus_topic=current_focus_topic,
    )

    question = result.get("question", "")
    question_count = state.get("question_count", 0) + 1

    events.append({
        "event": "question",
        "data": {
            "question": question,
            "questionNumber": question_count,
            "followUpRound": 0,
            "targetArea": result.get("targetArea", ""),
            "difficulty": result.get("difficulty", "medium"),
        },
    })

    return {
        **state,
        "current_question": question,
        "current_resume_chunks": chunks,
        "question_count": question_count,
        "follow_up_round": 0,
        "pending_events": events,
    }
```

- [ ] **Step 4: import 검증**

```
docker exec voice_training-backend-1 python -c "from app.agent.nodes import fit_analysis_node, generate_question; print('ok')"
```
Expected: `ok`

- [ ] **Step 5: Commit**

```bash
git add backend/app/agent/nodes.py
git commit -m "feat(agent): fit_analysis_node 추가 + generate_question 노드 RAG hook"
```

---

## Task 10: `routers/resume.py` — 저장 시 백그라운드 임베딩

**Files:**
- Modify: `backend/app/routers/resume.py`

- [ ] **Step 1: 영향 라우터 위치 확인**

```
docker exec voice_training-backend-1 grep -nE "@router\.(post|put|patch).*resume" /app/app/routers/resume.py
```
Expected: POST/PUT/PATCH 핸들러의 라인 번호.

- [ ] **Step 2: import + BackgroundTasks 의존 추가**

`backend/app/routers/resume.py` 상단 import에 추가:
```python
from fastapi import BackgroundTasks
from app.agent.resume_rag import embed_resume
```

- [ ] **Step 3: POST/PUT 핸들러 시그니처에 `background_tasks: BackgroundTasks` 추가**

이력서를 생성/수정하는 모든 엔드포인트에 다음 패턴 적용:
```python
@router.post("/api/resume")
async def create_resume(
    payload: ...,
    background_tasks: BackgroundTasks,
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    ...
    # 기존 commit/응답 완료 직전에 추가:
    background_tasks.add_task(embed_resume, resume.id, user.id, resume.parsed_data)
    return {...}
```

PUT/PATCH도 동일 패턴. `resume.parsed_data`가 변경된 경우에만 등록할 수도 있지만, 단순화를 위해 모든 수정에 등록 (전량 교체 비용 미미).

- [ ] **Step 4: 응답 자체에는 영향 없음 검증**

```
docker exec voice_training-backend-1 python -c "
import asyncio
from app.agent.resume_rag import embed_resume

async def main():
    n = await embed_resume('NONEXISTENT_ID', 'fake_user', {'summary': 'x'})
    # 외래키 위반으로 0 반환 + rollback (try/except 내부 처리)
    print('returned:', n)

asyncio.run(main())
" 2>&1 | tail -5
```
Expected: `returned: 0` (FK 위반 로그가 떠도 raise되지 않음).

- [ ] **Step 5: 실 라우터 수동 확인**

브라우저에서 `http://localhost:81` 로그인 → 이력서 새로 만들기 → 응답 즉시 옴 → 5초 후 DB 확인:
```
docker exec voice_training-backend-1 python -c "
import asyncio
from sqlalchemy import text
from app.database import async_session

async def main():
    async with async_session() as db:
        r = await db.execute(text('SELECT \"resumeId\", chunk_type, COUNT(*) FROM resume_embeddings GROUP BY \"resumeId\", chunk_type'))
        for row in r.fetchall():
            print(row)

asyncio.run(main())
"
```
Expected: 방금 만든 이력서 ID로 청크 N건 출력.

- [ ] **Step 6: Commit**

```bash
git add backend/app/routers/resume.py
git commit -m "feat(resume): 저장/수정 시 BackgroundTasks로 임베딩 자동 갱신"
```

---

## Task 11: `routers/agent_interview.py` — start에 fit_analysis_node 와이어링

**Files:**
- Modify: `backend/app/routers/agent_interview.py`

- [ ] **Step 1: 영향 위치 확인**

```
docker exec voice_training-backend-1 grep -nE "load_profile|generate_question|state\[.resume_id.\]" /app/app/routers/agent_interview.py
```
load_profile 호출 위치를 확인.

- [ ] **Step 2: state 초기화 + 흐름 수정 (한 군데서 처리)**

`agent_interview.py`의 start 엔드포인트에서 state dict 생성 직후 (load_profile 호출 직전)에 새 필드 기본값을 넣고, `load_profile` 다음 줄에 `fit_analysis_node`를 추가:

```python
# state 생성 직후
state["resume_id"] = resume_id  # 라우터 핸들러 인자명에 맞춤 (다를 경우 그 이름 사용)
state["fit_analysis"] = None
state["has_resume_embeddings"] = False
state["current_resume_chunks"] = []

# 노드 호출 흐름
state = await nodes.load_profile(state, db)
state = await nodes.fit_analysis_node(state, db)  # ← 추가
state = await nodes.generate_question(state, db)
```

만약 라우터 핸들러에 `resume_id`라는 변수가 없고 `payload.resumeId` 형태로만 접근하는 경우, `state["resume_id"] = payload.resumeId` 로 대체.

- [ ] **Step 3: import 검증 + 서버 재시작**

```
docker exec voice_training-backend-1 python -c "from app.routers.agent_interview import router; print('ok')"
docker compose restart backend
```
Expected: `ok`, 컨테이너 재시작 성공.

- [ ] **Step 4: Commit**

```bash
git add backend/app/routers/agent_interview.py
git commit -m "feat(agent-interview): start 엔드포인트에 fit_analysis_node 와이어링"
```

---

## Task 12: 백필 스크립트 + 1회 실행

**Files:**
- Create: `db/backfill_resume_embeddings.py`

- [ ] **Step 1: 백필 스크립트 작성**

`db/backfill_resume_embeddings.py`:
```python
"""기존 이력서 전량 백필 임베딩.

실행: docker exec voice_training-backend-1 python -m db.backfill_resume_embeddings
- 이력서 1건당 ~1초 소요 (배치 임베딩 + INSERT)
- 이미 임베딩 있는 이력서는 skip (or --force 시 재생성)
"""
from __future__ import annotations

import asyncio
import os
import sys

from sqlalchemy import text

from app.agent.resume_rag import embed_resume
from app.database import async_session


async def main(force: bool = False):
    async with async_session() as db:
        r = await db.execute(text('SELECT id, "userId", "parsedData" FROM resumes ORDER BY "createdAt"'))
        rows = r.fetchall()

    print(f"Total resumes: {len(rows)}")
    done = 0
    skipped = 0
    failed = 0

    for row in rows:
        rid = row.id
        uid = row.userId
        pd = row.parsedData

        if not force:
            async with async_session() as db:
                exists = (await db.execute(
                    text('SELECT 1 FROM resume_embeddings WHERE "resumeId" = :rid LIMIT 1'),
                    {"rid": rid},
                )).fetchone()
            if exists:
                skipped += 1
                continue

        n = await embed_resume(rid, uid, pd)
        if n > 0:
            done += 1
            print(f"  [{done}] resume {rid[:8]} → {n} chunks")
        else:
            failed += 1
            print(f"  FAILED: resume {rid[:8]}")

    print(f"\nDone: {done} embedded / {skipped} skipped / {failed} failed")


if __name__ == "__main__":
    force = "--force" in sys.argv
    asyncio.run(main(force=force))
```

- [ ] **Step 2: 실행 (skip 모드)**

```
docker exec voice_training-backend-1 python -m db.backfill_resume_embeddings
```
Expected: `Total resumes: N` + 이전 task에서 임베딩 안 된 이력서들이 모두 처리됨. 결과 카운트 출력.

- [ ] **Step 3: DB 검증**

```
docker exec voice_training-backend-1 python -c "
import asyncio
from sqlalchemy import text
from app.database import async_session

async def main():
    async with async_session() as db:
        r = await db.execute(text('SELECT COUNT(DISTINCT \"resumeId\") AS resumes, COUNT(*) AS chunks FROM resume_embeddings'))
        row = r.fetchone()
        print(f'embedded resumes: {row.resumes} / total chunks: {row.chunks}')
        r2 = await db.execute(text('SELECT COUNT(*) FROM resumes'))
        print(f'all resumes: {r2.scalar()}')

asyncio.run(main())
"
```
Expected: `embedded resumes` 수가 `all resumes`와 일치 (혹은 빈 parsedData 등으로 일부 적을 수 있음).

- [ ] **Step 4: Commit**

```bash
git add db/backfill_resume_embeddings.py
git commit -m "feat(db): 기존 이력서 백필 스크립트 — resume_embeddings 일괄 생성"
```

---

## Task 13: end-to-end 수동 검증

**Files:**
- Create: `backend/scripts/verify_resume_rag_e2e.py`

- [ ] **Step 1: e2e 검증 스크립트 작성**

`backend/scripts/verify_resume_rag_e2e.py`:
```python
"""end-to-end: 임베딩 → fit_analysis → search_resume까지 수동 검증.

실행: docker exec voice_training-backend-1 python -m scripts.verify_resume_rag_e2e
"""
from __future__ import annotations

import asyncio

from sqlalchemy import text

from app.agent.fit_analyzer import run_fit_analysis
from app.agent.resume_rag import embed_resume, has_resume_embeddings, search_resume
from app.database import async_session


async def main():
    async with async_session() as db:
        r = await db.execute(text('SELECT id, "userId", name, "parsedData" FROM resumes LIMIT 1'))
        row = r.fetchone()
        if not row:
            print("no resume; abort")
            return
        rid, uid, name, pd = row.id, row.userId, row.name, row.parsedData

    print(f"== Resume: {name} ({rid[:8]}) ==\n")

    n = await embed_resume(rid, uid, pd)
    print(f"[1] embed_resume → {n} chunks")

    async with async_session() as db:
        assert await has_resume_embeddings(db, rid), "expected embeddings present"
    print("[2] has_resume_embeddings → True")

    fa = await run_fit_analysis(pd, None)  # JD 없는 케이스
    print(f"[3] fit_analysis (JD=None):")
    print(f"    skill_match: {fa['skill_match']}")
    print(f"    focus_topics: {len(fa['focus_topics'])}건")
    for t in fa["focus_topics"]:
        print(f"      - [{t['priority']}] {t['topic']}")

    async with async_session() as db:
        for q in [
            "주요 프로젝트 경험",
            "성능 최적화",
            (fa["focus_topics"][0]["topic"] if fa["focus_topics"] else "팀 협업"),
        ]:
            res = await search_resume(db, uid, rid, q, top_k=3)
            print(f"\n[4] search_resume('{q}') → {len(res)}건")
            for c in res:
                print(f"    [{c['chunk_type']} sim={c['similarity']}] {c['content'][:80]}")

    print("\nALL DONE")


if __name__ == "__main__":
    asyncio.run(main())
```

- [ ] **Step 2: 실행**

```
docker exec voice_training-backend-1 python -m scripts.verify_resume_rag_e2e
```
Expected: 4단계 출력 + ALL DONE. 검색 결과가 query와 의미적으로 합치하는지 사람이 눈으로 확인.

- [ ] **Step 3: 실 면접 시작 검증 (브라우저)**

`http://localhost:81`에서 테스트 계정(`test@voiceprep.kr`)으로 로그인 → 이력서 선택 → AI 코치 면접 시작.
브라우저 DevTools Network 탭에서 `/api/agent-interview/start` SSE 응답 확인:
- `phase: profile_loaded` → `phase: fit_analyzing` → `phase: fit_analyzed` → `phase: generating_question` → `event: question` 순서로 와야 함.
- 첫 질문이 fit_analysis의 focus_topics와 정합한지 본다.

- [ ] **Step 4: fallback 동작 검증 (선택)**

특정 이력서의 임베딩 강제 삭제 후 면접 시작:
```
docker exec voice_training-backend-1 python -c "
import asyncio
from sqlalchemy import text
from app.database import async_session

async def main():
    async with async_session() as db:
        r = await db.execute(text('SELECT id FROM resumes LIMIT 1'))
        rid = r.fetchone().id
        await db.execute(text('DELETE FROM resume_embeddings WHERE \"resumeId\" = :rid'), {'rid': rid})
        await db.commit()
        print(f'deleted embeddings for {rid[:8]}')

asyncio.run(main())
"
```
그 이력서로 면접 시작 → SSE에서 `has_resume_embeddings: false` 확인 → 면접 진행되고 질문 정상 생성되는지 확인 (FALLBACK 프롬프트로 작동).

검증 후 백필 1회 재실행:
```
docker exec voice_training-backend-1 python -m db.backfill_resume_embeddings
```

- [ ] **Step 5: Commit**

```bash
git add backend/scripts/verify_resume_rag_e2e.py
git commit -m "chore(scripts): resume RAG end-to-end 검증 스크립트"
```

---

## 완료 후 점검

- [ ] **회귀 점검**: 기존 사용자(이력서 임베딩 있는 케이스)에서 면접 시작 → 첫 질문 생성까지 정상 흐름 확인
- [ ] **회귀 점검**: 임베딩 없는 이력서로도 면접 정상 시작 (fallback)
- [ ] **회귀 점검**: 꼬리질문/평가/리포트 흐름 미변경 확인
- [ ] **메모리 갱신**: `~/.claude/projects/.../memory/` 에 "이력서 RAG 작동 중" 같은 project 메모리 1건 추가 (다음 세션에서 컨텍스트 인지)
