from __future__ import annotations

import json
import logging
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload
from sse_starlette.sse import EventSourceResponse

from app.database import get_db
from app.dependencies import AuthUser, get_admin_user
from app.lib.anthropic_client import _get_client, MODELS, call_llm_json
from app.models.answer_assist import AnswerAssistSession, AnswerAssistItem
from app.models.resume import Resume
from app.prompts.answer_assist import (
    ANSWER_ASSIST_QUESTION_PROMPT,
    build_answer_assist_followup_prompt,
    build_answer_assist_compile_prompt,
)

logger = logging.getLogger(__name__)

router = APIRouter()


# ---------- Schemas ----------

class CreateSessionRequest(BaseModel):
    resumeId: str


class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=5000)


# ---------- POST /api/answer-assist/sessions ----------

@router.post("/api/answer-assist/sessions")
async def create_session(
    body: CreateSessionRequest,
    user: AuthUser = Depends(get_admin_user),
    db: AsyncSession = Depends(get_db),
):
    # Verify resume exists and belongs to user
    result = await db.execute(
        select(Resume).where(Resume.id == body.resumeId, Resume.user_id == user.id)
    )
    resume = result.scalar_one_or_none()
    if not resume:
        raise HTTPException(404, "\uc774\ub825\uc11c\ub97c \ucc3e\uc744 \uc218 \uc5c6\uc2b5\ub2c8\ub2e4")

    parsed_resume = (
        resume.parsed_data
        if isinstance(resume.parsed_data, str)
        else json.dumps(resume.parsed_data, indent=2, ensure_ascii=False)
    )

    # Generate questions via Claude
    prompt = f"{ANSWER_ASSIST_QUESTION_PROMPT}\n\n\uc774\ub825\uc11c:\n{parsed_resume}\n\n\uc704 \uc774\ub825\uc11c\ub97c \ubd84\uc11d\ud558\uc5ec \uba74\uc811 \uc9c8\ubb38\uc744 \uc0dd\uc131\ud558\uc138\uc694."
    try:
        data = await call_llm_json(
            prompt,
            model=MODELS["QUESTION_GEN"],
            temperature=0.7,
        )
    except Exception as e:
        logger.error("Question generation failed: %s", e)
        raise HTTPException(500, "\uc9c8\ubb38 \uc0dd\uc131\uc5d0 \uc2e4\ud328\ud588\uc2b5\ub2c8\ub2e4")

    questions = data.get("questions") if isinstance(data, dict) else None
    if not questions:
        raise HTTPException(500, "AI \uc751\ub2f5 \ud30c\uc2f1\uc5d0 \uc2e4\ud328\ud588\uc2b5\ub2c8\ub2e4")

    # Create session + items
    session_id = str(uuid4())
    assist_session = AnswerAssistSession(
        id=session_id,
        user_id=user.id,
        resume_id=body.resumeId,
    )
    db.add(assist_session)

    items = []
    for i, q in enumerate(questions):
        item = AnswerAssistItem(
            id=str(uuid4()),
            session_id=session_id,
            question_index=i,
            question_text=q["text"],
            conversation=[],
        )
        db.add(item)
        items.append(item)

    await db.commit()
    await db.refresh(assist_session)
    for item in items:
        await db.refresh(item)

    return {
        "id": assist_session.id,
        "userId": assist_session.user_id,
        "resumeId": assist_session.resume_id,
        "createdAt": assist_session.created_at.isoformat() if assist_session.created_at else None,
        "items": [
            {
                "id": it.id,
                "sessionId": it.session_id,
                "questionIndex": it.question_index,
                "questionText": it.question_text,
                "conversation": it.conversation or [],
                "finalAnswer": it.final_answer,
                "isCompleted": it.is_completed,
            }
            for it in sorted(items, key=lambda x: x.question_index)
        ],
    }


# ---------- GET /api/answer-assist/sessions ----------

@router.get("/api/answer-assist/sessions")
async def list_sessions(
    user: AuthUser = Depends(get_admin_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(AnswerAssistSession)
        .where(AnswerAssistSession.user_id == user.id)
        .options(selectinload(AnswerAssistSession.resume), selectinload(AnswerAssistSession.items))
        .order_by(AnswerAssistSession.created_at.desc())
    )
    sessions = result.scalars().all()

    return [
        {
            "id": s.id,
            "resumeName": s.resume.name if s.resume else None,
            "createdAt": s.created_at.isoformat() if s.created_at else None,
            "totalItems": len(s.items),
            "completedItems": sum(1 for it in s.items if it.is_completed),
        }
        for s in sessions
    ]


# ---------- GET /api/answer-assist/sessions/{session_id} ----------

@router.get("/api/answer-assist/sessions/{session_id}")
async def get_session(
    session_id: str,
    user: AuthUser = Depends(get_admin_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(AnswerAssistSession)
        .where(AnswerAssistSession.id == session_id, AnswerAssistSession.user_id == user.id)
        .options(selectinload(AnswerAssistSession.resume), selectinload(AnswerAssistSession.items))
    )
    assist_session = result.scalar_one_or_none()
    if not assist_session:
        raise HTTPException(404, "\uc138\uc158\uc744 \ucc3e\uc744 \uc218 \uc5c6\uc2b5\ub2c8\ub2e4")

    return {
        "id": assist_session.id,
        "userId": assist_session.user_id,
        "resumeId": assist_session.resume_id,
        "createdAt": assist_session.created_at.isoformat() if assist_session.created_at else None,
        "updatedAt": assist_session.updated_at.isoformat() if assist_session.updated_at else None,
        "resume": {
            "name": assist_session.resume.name if assist_session.resume else None,
            "parsedData": assist_session.resume.parsed_data if assist_session.resume else None,
        },
        "items": [
            {
                "id": it.id,
                "sessionId": it.session_id,
                "questionIndex": it.question_index,
                "questionText": it.question_text,
                "conversation": it.conversation or [],
                "finalAnswer": it.final_answer,
                "isCompleted": it.is_completed,
            }
            for it in sorted(assist_session.items, key=lambda x: x.question_index)
        ],
    }


# ---------- POST /api/answer-assist/sessions/{session_id}/items/{item_id}/chat ----------

@router.post("/api/answer-assist/sessions/{session_id}/items/{item_id}/chat")
async def chat_item(
    session_id: str,
    item_id: str,
    body: ChatRequest,
    user: AuthUser = Depends(get_admin_user),
    db: AsyncSession = Depends(get_db),
):
    # Verify session
    sess_result = await db.execute(
        select(AnswerAssistSession)
        .where(AnswerAssistSession.id == session_id, AnswerAssistSession.user_id == user.id)
        .options(selectinload(AnswerAssistSession.resume))
    )
    assist_session = sess_result.scalar_one_or_none()
    if not assist_session:
        raise HTTPException(404, "\uc138\uc158\uc744 \ucc3e\uc744 \uc218 \uc5c6\uc2b5\ub2c8\ub2e4")

    # Verify item
    item_result = await db.execute(
        select(AnswerAssistItem).where(
            AnswerAssistItem.id == item_id,
            AnswerAssistItem.session_id == session_id,
        )
    )
    item = item_result.scalar_one_or_none()
    if not item:
        raise HTTPException(404, "\ud56d\ubaa9\uc744 \ucc3e\uc744 \uc218 \uc5c6\uc2b5\ub2c8\ub2e4")

    # Append user message
    conversation: list[dict[str, str]] = list(item.conversation or [])
    conversation.append({"role": "user", "content": body.message.strip()})
    item.conversation = conversation
    await db.commit()

    # Build prompt
    parsed_resume = (
        assist_session.resume.parsed_data
        if isinstance(assist_session.resume.parsed_data, str)
        else json.dumps(assist_session.resume.parsed_data, indent=2, ensure_ascii=False)
    )
    prompts = build_answer_assist_followup_prompt(
        parsed_resume, item.question_text, conversation
    )

    async def event_generator():
        client = _get_client()
        accumulated = ""
        try:
            async with client.messages.stream(
                model=MODELS["ANALYSIS"],
                max_tokens=1024,
                temperature=0.7,
                system=prompts["system"],
                messages=[{"role": "user", "content": prompts["user"]}],
            ) as stream:
                async for event in stream:
                    if event.type == "content_block_delta" and hasattr(event.delta, "text"):
                        accumulated += event.delta.text
                        yield {"data": json.dumps({"text": event.delta.text})}

            # Save AI response
            conversation.append({"role": "ai", "content": accumulated})
            item.conversation = conversation
            await db.commit()

            yield {"data": "[DONE]"}
        except Exception as e:
            logger.error("Chat streaming error: %s", e)
            yield {"data": json.dumps({"error": "\uc751\ub2f5 \uc0dd\uc131 \uc911 \uc624\ub958\uac00 \ubc1c\uc0dd\ud588\uc2b5\ub2c8\ub2e4"})}

    return EventSourceResponse(event_generator())


# ---------- POST /api/answer-assist/sessions/{session_id}/items/{item_id}/compile ----------

@router.post("/api/answer-assist/sessions/{session_id}/items/{item_id}/compile")
async def compile_item(
    session_id: str,
    item_id: str,
    user: AuthUser = Depends(get_admin_user),
    db: AsyncSession = Depends(get_db),
):
    # Verify session
    sess_result = await db.execute(
        select(AnswerAssistSession)
        .where(AnswerAssistSession.id == session_id, AnswerAssistSession.user_id == user.id)
        .options(selectinload(AnswerAssistSession.resume))
    )
    assist_session = sess_result.scalar_one_or_none()
    if not assist_session:
        raise HTTPException(404, "\uc138\uc158\uc744 \ucc3e\uc744 \uc218 \uc5c6\uc2b5\ub2c8\ub2e4")

    # Verify item
    item_result = await db.execute(
        select(AnswerAssistItem).where(
            AnswerAssistItem.id == item_id,
            AnswerAssistItem.session_id == session_id,
        )
    )
    item = item_result.scalar_one_or_none()
    if not item:
        raise HTTPException(404, "\ud56d\ubaa9\uc744 \ucc3e\uc744 \uc218 \uc5c6\uc2b5\ub2c8\ub2e4")

    conversation: list[dict[str, str]] = list(item.conversation or [])
    if not conversation:
        raise HTTPException(400, "\ub300\ud654 \ub0b4\uc6a9\uc774 \uc5c6\uc2b5\ub2c8\ub2e4")

    # Build prompt
    parsed_resume = (
        assist_session.resume.parsed_data
        if isinstance(assist_session.resume.parsed_data, str)
        else json.dumps(assist_session.resume.parsed_data, indent=2, ensure_ascii=False)
    )
    prompts = build_answer_assist_compile_prompt(
        parsed_resume, item.question_text, conversation
    )

    async def event_generator():
        client = _get_client()
        accumulated = ""
        try:
            async with client.messages.stream(
                model=MODELS["ANALYSIS"],
                max_tokens=2048,
                temperature=0.5,
                system=prompts["system"],
                messages=[{"role": "user", "content": prompts["user"]}],
            ) as stream:
                async for event in stream:
                    if event.type == "content_block_delta" and hasattr(event.delta, "text"):
                        accumulated += event.delta.text
                        yield {"data": json.dumps({"text": event.delta.text})}

            # Save final answer
            item.final_answer = accumulated
            item.is_completed = True
            await db.commit()

            yield {"data": "[DONE]"}
        except Exception as e:
            logger.error("Compile streaming error: %s", e)
            yield {"data": json.dumps({"error": "\ucd5c\uc885 \ub2f5\ubcc0 \uc815\ub9ac \uc911 \uc624\ub958\uac00 \ubc1c\uc0dd\ud588\uc2b5\ub2c8\ub2e4"})}

    return EventSourceResponse(event_generator())
