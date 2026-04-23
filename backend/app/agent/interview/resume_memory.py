# backend/app/agent/resume_rag.py
"""이력서 RAG: 청크, 임베딩, 검색."""
from __future__ import annotations

import json
import logging
from typing import Literal, TypedDict

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.embeddings import _get_openai_client, EMBEDDING_MODEL
from app.database import async_session

logger = logging.getLogger(__name__)

ChunkType = Literal["summary", "project", "experience", "education"]


class Chunk(TypedDict):
    chunk_type: ChunkType
    # 원본 배열 인덱스. 건너뛴 항목이 있어도 DB UNIQUE("resumeId", chunk_type, chunk_index)에 사용한다.
    chunk_index: int
    content: str
    metadata: dict


def _join_nonempty(parts: list[str], sep: str = " | ") -> str:
    """빈 segment를 제거하고 join한다."""
    return sep.join(p for p in parts if p)


def _format_list(values: list, max_items: int = 10) -> str:
    """리스트(achievements/techStack)를 ', '로 join한다. 빈 값은 무시한다."""
    if not isinstance(values, list):
        return ""
    return ", ".join(str(v).strip() for v in values[:max_items] if str(v).strip())


def chunk_resume(parsed_data: dict | None) -> list[Chunk]:
    """이력서 parsedData를 청크 리스트로 변환한다.

    Spec D3: summary/project/experience/education만 임베딩하고 skills는 제외한다.
    각 프로젝트/경력은 description + achievements를 한 청크로 통합한다.
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


async def _embed_batch(contents: list[str]) -> list[list[float]]:
    """OpenAI 배치 임베딩(1회 호출). 빈 입력은 API 호출 없이 []를 반환한다."""
    if not contents:
        return []
    client = _get_openai_client()
    response = await client.embeddings.create(model=EMBEDDING_MODEL, input=contents)
    return [d.embedding for d in response.data]


def _vec_str(v: list[float]) -> str:
    return "[" + ",".join(str(x) for x in v) + "]"


async def has_resume_embeddings(db: AsyncSession, resume_id: str) -> bool:
    """이력서에 임베딩이 1건이라도 있는지 확인한다. 면접 시작 시 SLIM/FALLBACK 분기에 사용한다."""
    r = await db.execute(
        text('SELECT 1 FROM resume_embeddings WHERE "resumeId" = :rid LIMIT 1'),
        {"rid": resume_id},
    )
    return r.fetchone() is not None


async def embed_resume(resume_id: str, user_id: str, parsed_data: dict | None) -> int:
    """청크를 배치 임베딩하고 전량 교체한다. BackgroundTask에서 호출하며 자체 세션을 사용한다.

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
            # BackgroundTask 컨텍스트라 호출자에게 전파할 수 없으므로 로그 후 0을 반환한다.
            # 의도적인 broad catch다. logger.exception으로 stack trace를 보존한다.
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
    """이력서 청크를 코사인 유사도로 검색한다."""
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
