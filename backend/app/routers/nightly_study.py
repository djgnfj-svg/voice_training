from __future__ import annotations

import ctypes
import json
import logging
import random
from datetime import datetime, timezone, timedelta
from pathlib import Path
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.config import settings
from app.database import get_db
from app.dependencies import AuthUser, get_current_user
from app.lib.anthropic_client import call_llm_json, MODELS
from app.models.activity import ActivityLog, ActivityItem
from app.models.learning import Topic, UserKnowledge
from app.prompts.nightly_study import (
    NIGHTLY_TUTOR_QUESTION_PROMPT,
    NIGHTLY_TUTOR_RESPONSE_PROMPT,
    NIGHTLY_STUDY_SUMMARY_PROMPT,
)
from app.services import knowledge as knowledge_service
from app.services import daily_progress as daily_progress_service

logger = logging.getLogger(__name__)

router = APIRouter()

KST = timezone(timedelta(hours=9))

# ---------------------------------------------------------------------------
# Question bank loading
# ---------------------------------------------------------------------------
_QUESTIONS_DIR = Path(__file__).resolve().parent.parent / "data" / "questions"

VALID_CATEGORIES = [
    "CS_BASICS",
    "JAVASCRIPT",
    "REACT",
    "NEXTJS",
    "TYPESCRIPT",
    "DATABASE",
    "DEVOPS",
]

_CATEGORY_FILE_MAP: dict[str, str] = {
    "CS_BASICS": "cs-basics.json",
    "JAVASCRIPT": "javascript.json",
    "REACT": "react.json",
    "NEXTJS": "nextjs.json",
    "TYPESCRIPT": "typescript-advanced.json",
    "DATABASE": "database-advanced.json",
    "DEVOPS": "devops.json",
}

_bank_cache: dict[str, dict] = {}


def _load_bank(category: str) -> dict | None:
    if category in _bank_cache:
        return _bank_cache[category]
    filename = _CATEGORY_FILE_MAP.get(category)
    if not filename:
        return None
    path = _QUESTIONS_DIR / filename
    if not path.exists():
        return None
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    _bank_cache[category] = data
    return data


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _hash_question(q: str) -> str:
    """Java-style string hash, matching the TS implementation."""
    h = 0
    for ch in q:
        h = ((h << 5) - h + ord(ch)) & 0xFFFFFFFF
        # Emulate JS |0 (signed 32-bit)
        h = ctypes.c_int32(h).value
    # Emulate >>> 0
    h = h & 0xFFFFFFFF
    # Convert to base36 padded to 6 chars
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    result = ""
    if h == 0:
        result = "0"
    else:
        while h > 0:
            result = digits[h % 36] + result
            h //= 36
    return result.rjust(6, "0")


def _get_kst_midnight() -> datetime:
    """Return the start of today in KST as a UTC datetime."""
    now_kst = datetime.now(KST)
    midnight_kst = now_kst.replace(hour=0, minute=0, second=0, microsecond=0)
    return midnight_kst.astimezone(timezone.utc).replace(tzinfo=None)


def _pick_random_questions(
    categories: list[str], count: int
) -> list[dict]:
    pool: list[dict] = []
    for cat in categories:
        bank = _load_bank(cat)
        if not bank:
            continue
        for q in bank.get("questions", []):
            pool.append({"question": q, "category": cat})

    random.shuffle(pool)
    return pool[:count]


async def _pick_smart_questions(
    db: AsyncSession,
    *,
    user_id: str,
    categories: list[str],
    count: int,
) -> list[dict]:
    """Learning-memory-based smart question picking: dedup + weakness priority + review schedule."""
    pool: list[dict] = []
    for cat in categories:
        bank = _load_bank(cat)
        if not bank:
            continue
        for q in bank.get("questions", []):
            pool.append({"question": q, "category": cat})
    if not pool:
        return []

    # Gather past asked question hashes from ActivityItem
    stmt = (
        select(ActivityItem.question)
        .join(ActivityLog, ActivityItem.activity_log_id == ActivityLog.id)
        .where(
            ActivityLog.user_id == user_id,
            ActivityLog.type == "NIGHTLY_STUDY",
        )
    )
    result = await db.execute(stmt)
    asked_set = {_hash_question(row[0]) for row in result.all()}

    # User knowledge
    all_knowledge = await knowledge_service.get_user_knowledge(db, user_id=user_id)

    # Build knowledge map: topic name (lowercase) -> entry
    knowledge_map: dict[str, dict] = {}
    for k in all_knowledge:
        meta = k.metadata_ or {}
        entry = {
            "proficiency": k.proficiency,
            "nextReviewAt": k.next_review_at,
            "metadata": meta,
        }
        knowledge_map[k.topic.name.lower()] = entry

    # Score each question
    now = datetime.now(timezone.utc)
    scored: list[dict] = []

    for item in pool:
        q_hash = _hash_question(item["question"]["questionText"])
        is_asked = q_hash in asked_set

        sub = item["question"].get("subcategory", "").lower()
        k_entry = knowledge_map.get(sub)
        if not k_entry:
            for name, entry in knowledge_map.items():
                if name in sub or sub in name.split()[0]:
                    k_entry = entry
                    break

        if not k_entry:
            priority = 50.0  # Unstudied topic -> middle
        else:
            is_due = k_entry["nextReviewAt"] and k_entry["nextReviewAt"] <= now
            has_weak_points = len(k_entry["metadata"].get("weakPoints", [])) > 0

            if is_due:
                priority = 10.0  # Due for review -> highest
            elif k_entry["proficiency"] < 40 and has_weak_points:
                priority = 20.0  # Weak + specific weak points
            elif k_entry["proficiency"] < 60:
                priority = 40.0  # Average
            else:
                priority = 70.0 + k_entry["proficiency"] * 0.3  # Strong -> avoid

        if is_asked:
            priority += 200.0

        jitter = random.uniform(-7.5, 7.5)
        scored.append({**item, "score": priority + jitter, "isAsked": is_asked})

    scored.sort(key=lambda s: s["score"])

    def _build_profile(subcategory: str) -> str:
        sub = subcategory.lower()
        k_entry = knowledge_map.get(sub)
        if not k_entry:
            for name, entry in knowledge_map.items():
                if name in sub or sub in name.split()[0]:
                    k_entry = entry
                    break
        if not k_entry:
            return "(이 주제는 처음 학습)"

        parts: list[str] = []
        parts.append(f"숙련도: {k_entry['proficiency']}/100")
        parts.append(f"학습 횟수: {k_entry['metadata'].get('studyCount', 0)}회")
        weak = k_entry["metadata"].get("weakPoints", [])
        if weak:
            parts.append(f"약점: {', '.join(weak[:3])}")
        return " | ".join(parts)

    return [
        {
            "question": s["question"],
            "category": s["category"],
            "learnerProfile": _build_profile(s["question"].get("subcategory", "")),
        }
        for s in scored[:count]
    ]


# ---------------------------------------------------------------------------
# Request / Response schemas
# ---------------------------------------------------------------------------

class StartRequest(BaseModel):
    categories: list[str]
    mode: str  # 'deep' | 'light'
    resumeId: str | None = None


class ConversationEntry(BaseModel):
    role: str  # 'tutor' | 'user'
    content: str


class RespondRequest(BaseModel):
    questionText: str
    userAnswer: str
    conversationHistory: list[ConversationEntry] = Field(default_factory=list)
    mode: str  # 'deep' | 'light'
    round: int
    keyPoints: list[str] = Field(default_factory=list)


class QuestionResult(BaseModel):
    originalQuestion: str
    tutorQuestion: str
    category: str
    subcategory: str
    conversation: list[ConversationEntry] = Field(default_factory=list)
    conceptsCovered: list[str] = Field(default_factory=list)
    keyPoints: list[str] = Field(default_factory=list)
    understandingScore: int = 50
    weakPoints: list[str] = Field(default_factory=list)


class CompleteRequest(BaseModel):
    questions: list[QuestionResult]
    mode: str  # 'deep' | 'light'
    resumeId: str | None = None


# ---------------------------------------------------------------------------
# POST /api/nightly-study/start
# ---------------------------------------------------------------------------

@router.post("/api/nightly-study/start")
async def start_nightly_study(
    body: StartRequest,
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    # Validate categories
    for cat in body.categories:
        if cat not in VALID_CATEGORIES:
            raise HTTPException(400, f"Invalid category: {cat}")
    if not body.categories:
        raise HTTPException(400, "At least one category is required")
    if body.mode not in ("deep", "light"):
        raise HTTPException(400, "mode must be 'deep' or 'light'")

    # Daily limit check (skip in dev)
    if not settings.is_dev:
        kst_midnight = _get_kst_midnight()
        stmt = select(ActivityLog).where(
            ActivityLog.user_id == user.id,
            ActivityLog.type == "NIGHTLY_STUDY",
            ActivityLog.created_at >= kst_midnight,
        )
        result = await db.execute(stmt)
        if result.scalar_one_or_none():
            raise HTTPException(
                429,
                {"error": "오늘은 이미 학습을 완료했어요!", "code": "DAILY_LIMIT_REACHED"},
            )

    # Pick questions based on mode (smart picking with random fallback)
    question_count = 1 if body.mode == "deep" else 2
    try:
        picked = await _pick_smart_questions(
            db, user_id=user.id, categories=body.categories, count=question_count
        )
    except Exception:
        picked = _pick_random_questions(body.categories, question_count)

    if not picked:
        raise HTTPException(400, "선택한 카테고리에 질문이 없습니다")

    # Generate conversational questions via AI
    questions = []
    for item in picked:
        q = item["question"]
        learner_profile = item.get("learnerProfile", "(첫 학습)")

        prompt = (
            NIGHTLY_TUTOR_QUESTION_PROMPT
            .replace("{bankQuestion}", q["questionText"])
            .replace("{keyPoints}", ", ".join(q.get("keyPoints", [])))
            .replace("{learnerProfile}", learner_profile)
        )

        try:
            parsed = await call_llm_json(
                prompt, model=MODELS["QUESTION_GEN"], temperature=0.7, max_tokens=512
            )
        except Exception:
            parsed = {"tutorQuestion": q["questionText"]}

        questions.append({
            "originalQuestion": q["questionText"],
            "tutorQuestion": parsed.get("tutorQuestion") or q["questionText"],
            "keyPoints": q.get("keyPoints", []),
            "category": item["category"],
            "subcategory": q.get("subcategory", ""),
        })

    return {"questions": questions}


# ---------------------------------------------------------------------------
# POST /api/nightly-study/respond
# ---------------------------------------------------------------------------

@router.post("/api/nightly-study/respond")
async def respond_nightly_study(
    body: RespondRequest,
    user: AuthUser = Depends(get_current_user),
):
    max_rounds = 5 if body.mode == "deep" else 3

    history_str = "\n".join(
        f"{'튜터' if h.role == 'tutor' else '학생'}: {h.content}"
        for h in body.conversationHistory
    ) or "(첫 번째 답변)"

    user_answer = body.userAnswer or "(답변 없음 — 잘 모르겠다고 함)"

    prompt = (
        NIGHTLY_TUTOR_RESPONSE_PROMPT
        .replace("{originalQuestion}", body.questionText)
        .replace("{keyPoints}", ", ".join(body.keyPoints))
        .replace("{conversationHistory}", history_str)
        .replace("{userAnswer}", user_answer)
        .replace("{round}", str(body.round))
        .replace("{maxRounds}", str(max_rounds))
    )

    try:
        parsed = await call_llm_json(
            prompt, model=MODELS["EVALUATION"], temperature=0.6, max_tokens=1024
        )
    except Exception:
        raise HTTPException(500, "AI 응답 생성에 실패했습니다")

    return {
        "tutorResponse": parsed.get("tutorResponse", ""),
        "followUpQuestion": parsed.get("followUpQuestion"),
        "isComplete": parsed.get("isComplete", body.round >= max_rounds),
        "conceptsCovered": parsed.get("conceptsCovered", []),
        "understandingScore": parsed.get("understandingScore", 50),
        "weakPoints": parsed.get("weakPoints", []),
    }


# ---------------------------------------------------------------------------
# POST /api/nightly-study/complete
# ---------------------------------------------------------------------------

@router.post("/api/nightly-study/complete")
async def complete_nightly_study(
    body: CompleteRequest,
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    # Build session data for summary
    session_data = []
    for q in body.questions:
        conversation_str = "\n".join(
            f"{'튜터' if c.role == 'tutor' else '학생'}: {c.content}"
            for c in q.conversation
        )
        session_data.append({
            "question": q.originalQuestion,
            "category": q.category,
            "conversationLength": len(q.conversation),
            "conceptsCovered": q.conceptsCovered,
            "keyPoints": q.keyPoints,
            "conversation": conversation_str,
        })

    prompt = NIGHTLY_STUDY_SUMMARY_PROMPT.replace(
        "{sessionData}", json.dumps(session_data, ensure_ascii=False, indent=2)
    )

    fallback_summary = {"strengths": [], "reviewTopics": [], "encouragement": "오늘도 수고했어요!"}
    try:
        summary = await call_llm_json(
            prompt, model=MODELS["ANALYSIS"], temperature=0.5
        )
    except Exception:
        summary = fallback_summary

    # Save ActivityLog + ActivityItems (no credit deduction)
    activity_log = ActivityLog(
        id=str(uuid4()),
        user_id=user.id,
        type="NIGHTLY_STUDY",
        resume_id=body.resumeId or None,
        metadata_={"mode": body.mode, "summary": summary},
    )
    db.add(activity_log)
    await db.flush()

    for idx, q in enumerate(body.questions):
        user_answers = "\n".join(
            c.content for c in q.conversation if c.role == "user"
        )
        item = ActivityItem(
            id=str(uuid4()),
            activity_log_id=activity_log.id,
            index=idx,
            question=q.originalQuestion,
            answer=user_answers,
            extra={
                "category": q.category,
                "subcategory": q.subcategory,
                "conceptsCovered": q.conceptsCovered,
                "conversationLength": len(q.conversation),
            },
        )
        db.add(item)

    # Update learning memory
    try:
        for q in body.questions:
            # subcategory -> topic mapping (multi-step fallback)
            topic = await _find_topic(db, subcategory=q.subcategory, key_points=q.keyPoints)
            if not topic:
                continue

            # Read existing metadata
            stmt = select(UserKnowledge).where(
                UserKnowledge.user_id == user.id,
                UserKnowledge.topic_id == topic.id,
            )
            result = await db.execute(stmt)
            existing = result.scalar_one_or_none()
            prev_meta = (existing.metadata_ if existing and existing.metadata_ else None) or {
                "askedQuestions": [],
                "weakPoints": [],
                "lastScore": 0,
                "studyCount": 0,
            }

            q_hash = _hash_question(q.originalQuestion)

            # Merge weak points
            if q.understandingScore >= 80:
                merged_weak = (q.weakPoints or [])[:5]
            else:
                merged_weak = list(dict.fromkeys(
                    (prev_meta.get("weakPoints") or []) + (q.weakPoints or [])
                ))[-5:]

            new_meta = {
                "askedQuestions": ((prev_meta.get("askedQuestions") or []) + [q_hash])[-30:],
                "weakPoints": merged_weak,
                "lastScore": q.understandingScore,
                "studyCount": (prev_meta.get("studyCount") or 0) + 1,
            }

            was_correct = q.understandingScore >= 60
            await knowledge_service.update_knowledge(
                db,
                user_id=user.id,
                topic_id=topic.id,
                was_correct=was_correct,
                score=q.understandingScore,
                metadata=new_meta,
            )

        # Record daily progress
        topics_studied = list({q.subcategory for q in body.questions})
        await daily_progress_service.record_progress(
            db,
            user_id=user.id,
            session_data={
                "subjectId": "nightly-study",
                "totalQuestions": len(body.questions),
                "correctCount": sum(1 for q in body.questions if q.understandingScore >= 60),
                "durationSeconds": 0,
                "topicsStudied": topics_studied,
            },
        )
    except Exception:
        logger.exception("Failed to update learning memory")

    await db.commit()
    return {"summary": summary}


# ---------------------------------------------------------------------------
# GET /api/nightly-study/status
# ---------------------------------------------------------------------------

@router.get("/api/nightly-study/status")
async def nightly_study_status(
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if settings.is_dev:
        return {"dailyLimitReached": False}

    kst_midnight = _get_kst_midnight()
    stmt = select(ActivityLog).where(
        ActivityLog.user_id == user.id,
        ActivityLog.type == "NIGHTLY_STUDY",
        ActivityLog.created_at >= kst_midnight,
    )
    result = await db.execute(stmt)
    today_session = result.scalar_one_or_none()

    return {"dailyLimitReached": today_session is not None}


# ---------------------------------------------------------------------------
# GET /api/nightly-study/history
# ---------------------------------------------------------------------------

@router.get("/api/nightly-study/history")
async def nightly_study_history(
    user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    # Recent sessions (last 10)
    stmt = (
        select(ActivityLog)
        .options(selectinload(ActivityLog.items))
        .where(
            ActivityLog.user_id == user.id,
            ActivityLog.type == "NIGHTLY_STUDY",
        )
        .order_by(ActivityLog.created_at.desc())
        .limit(10)
    )
    result = await db.execute(stmt)
    recent_sessions = result.scalars().all()

    # Topic proficiency
    all_knowledge = await knowledge_service.get_user_knowledge(db, user_id=user.id)

    sessions = []
    for s in recent_sessions:
        meta = s.metadata_ or {}
        sorted_items = sorted(s.items, key=lambda i: i.index)
        sessions.append({
            "id": s.id,
            "createdAt": s.created_at.isoformat() if s.created_at else None,
            "mode": meta.get("mode", "deep"),
            "questionCount": len(s.items),
            "topics": [
                (i.extra or {}).get("subcategory", "일반") for i in sorted_items
            ],
            "summary": meta.get("summary"),
        })

    topics = []
    for k in all_knowledge:
        meta = k.metadata_ or {}
        topics.append({
            "topicId": k.topic_id,
            "topicName": k.topic.name,
            "subjectId": k.topic.subject_id,
            "proficiency": k.proficiency,
            "studyCount": meta.get("studyCount", (k.success_count or 0) + (k.failure_count or 0)),
            "lastScore": meta.get("lastScore", 0),
            "weakPoints": meta.get("weakPoints", []),
            "nextReviewAt": k.next_review_at.isoformat() if k.next_review_at else None,
        })

    return {"sessions": sessions, "topics": topics}


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

async def _find_topic(
    db: AsyncSession,
    *,
    subcategory: str,
    key_points: list[str],
) -> Topic | None:
    """Multi-step fallback to find a Topic from a subcategory string."""
    from sqlalchemy import func as sa_func

    # 1. Exact match (case-insensitive)
    stmt = select(Topic).where(sa_func.lower(Topic.name) == subcategory.lower())
    result = await db.execute(stmt)
    topic = result.scalar_one_or_none()
    if topic:
        return topic

    # 2. Contains match
    stmt = select(Topic).where(sa_func.lower(Topic.name).contains(subcategory.lower()))
    result = await db.execute(stmt)
    topic = result.scalars().first()
    if topic:
        return topic

    # 3. First word of subcategory -> subject name
    first_word = subcategory.split("/")[0].split()[0] if subcategory else ""
    if first_word and first_word != subcategory:
        from app.models.learning import Subject
        stmt = (
            select(Topic)
            .join(Subject)
            .where(sa_func.lower(Subject.name).contains(first_word.lower()))
        )
        result = await db.execute(stmt)
        topic = result.scalars().first()
        if topic:
            return topic

    # 4. Match by key_points overlap
    if key_points:
        stmt = select(Topic).where(Topic.key_points.overlap(key_points[:3]))
        result = await db.execute(stmt)
        topic = result.scalars().first()
        if topic:
            return topic

    return None
