# backend/app/agent/resume_rag.py
"""?대젰??RAG: 泥?궧, ?꾨쿋?? 寃??"""
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
    # ?먮낯 諛곗뿴 ?몃뜳??(嫄대꼫????ぉ ?덉쓣 ??鍮꾩뿰??. DB UNIQUE("resumeId", chunk_type, chunk_index) ?ㅻ줈 ?ъ슜.
    chunk_index: int
    content: str
    metadata: dict


def _join_nonempty(parts: list[str], sep: str = " | ") -> str:
    """鍮?segment ?쒓굅 ??join."""
    return sep.join(p for p in parts if p)


def _format_list(values: list, max_items: int = 10) -> str:
    """由ъ뒪??achievements/techStack)瑜?', '濡?join. 鍮?媛?臾댁떆."""
    if not isinstance(values, list):
        return ""
    return ", ".join(str(v).strip() for v in values[:max_items] if str(v).strip())


def chunk_resume(parsed_data: dict | None) -> list[Chunk]:
    """?대젰??parsedData瑜?泥?겕 由ъ뒪?몃줈 蹂??

    Spec D3: summary/project/experience/education留??꾨쿋?? skills ?쒖쇅.
    媛??꾨줈?앺듃/寃쎈젰? description + achievements瑜???泥?겕濡??듯빀 (留λ씫 蹂댁〈).
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
                f"[?꾨줈?앺듃] {name}" if name else "",
                period,
                f"湲곗닠: {tech}" if tech else "",
                f"??븷: {role}" if role else "",
                description,
                f"?깃낵: {achievements}" if achievements else "",
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
                f"[寃쎈젰] {header}" if header else "",
                period,
                f"湲곗닠: {tech}" if tech else "",
                description,
                f"?깃낵: {achievements}" if achievements else "",
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
                f"[?숇젰] {header}" if header else "",
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
    """OpenAI 諛곗튂 ?꾨쿋??(1???몄텧). 鍮??낅젰? API ?몄텧 ?놁씠 [] 諛섑솚."""
    if not contents:
        return []
    client = _get_openai_client()
    response = await client.embeddings.create(model=EMBEDDING_MODEL, input=contents)
    return [d.embedding for d in response.data]


def _vec_str(v: list[float]) -> str:
    return "[" + ",".join(str(x) for x in v) + "]"


async def has_resume_embeddings(db: AsyncSession, resume_id: str) -> bool:
    """?대젰?쒖뿉 ?꾨쿋?⑹씠 1嫄댁씠?쇰룄 ?덈뒗吏 ?뺤씤. 硫댁젒 ?쒖옉 ??SLIM/FALLBACK 遺꾧린 ?먯젙??"""
    r = await db.execute(
        text('SELECT 1 FROM resume_embeddings WHERE "resumeId" = :rid LIMIT 1'),
        {"rid": resume_id},
    )
    return r.fetchone() is not None


async def embed_resume(resume_id: str, user_id: str, parsed_data: dict | None) -> int:
    """泥?궧 ??諛곗튂 ?꾨쿋?????꾨웾 援먯껜. BackgroundTask濡??몄텧?섎ŉ ?먯껜 ?몄뀡 ?ъ슜.

    Returns: ??λ맂 泥?겕 媛쒖닔.
    """
    chunks = chunk_resume(parsed_data)
    async with async_session() as db:
        try:
            # ?꾨웾 援먯껜
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
            # BackgroundTask 而⑦뀓?ㅽ듃 ???몄텧?먯뿉寃??꾪뙆?????놁쑝誘濡?濡쒓렇 + 0 諛섑솚.
            # ?섎룄??愿묐쾾??catch (醫곹엳硫?worker ?ㅻ젅??二쎌쓬). logger.exception濡?stack trace 蹂댁〈.
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
    """?대젰??泥?겕 肄붿궗???좎궗??寃??"""
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
