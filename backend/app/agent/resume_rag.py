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
