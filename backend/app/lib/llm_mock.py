"""E2E mock for LLM/embedding calls. Activated by E2E_MOCK_LLM=1.

Returns deterministic canned responses so Playwright tests stay reproducible
and free of OpenAI cost. Pattern-matches on prompt content to choose shape.

NOTE: This only stubs the public functions in `llm_client` (call_llm,
call_llm_json, call_llm_stream, call_llm_vision) plus the embedding entry
point in `app.agent.embeddings`. The learning-coach LangGraph agentic loop
talks to AsyncOpenAI directly via tool-calling and is NOT mocked here;
specs that exercise it must either avoid that graph or run against the
real API.
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import math
from typing import Any, AsyncIterator

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# JSON shape dispatcher
# ---------------------------------------------------------------------------

def _agent_evaluation_shape() -> dict[str, Any]:
    """Shape for agent EVALUATOR_PROMPT (interview/evaluation.py).

    overallScore is overwritten server-side as weighted avg, but include
    the rest. demonstratedKeywords/missingKeywords are normalized server-side.
    """
    return {
        "scores": {
            "clarity": 75,
            "accuracy": 70,
            "practicality": 70,
            "depth": 65,
            "completeness": 70,
        },
        "briefFeedback": "Mock 평가 — 답변이 핵심을 짚었고 구체적 사례를 들었습니다. 트레이드오프 설명을 더 보완하면 좋겠습니다.",
        "detailedFeedback": "Mock 상세 피드백입니다. 답변 구조가 명확하고 기술 선택의 근거를 잘 설명했습니다. 다만 대안 기술과의 비교 및 운영 관점 트레이드오프를 한 문장 더 추가했다면 더 좋았을 것입니다.",
        "modelAnswer": "Mock 모범 답안입니다. 실제 프로젝트에서 이러한 결정을 내릴 때는 처리량, 일관성, 운영 비용을 함께 고려합니다.",
        "demonstratedKeywords": ["FastAPI", "PostgreSQL"],
        "missingKeywords": ["인덱스 전략"],
        "weaknessDetected": None,
    }


def _legacy_eval_shape() -> dict[str, Any]:
    """Shape for legacy evaluation_pipeline prompts (technical/deep/behavioral/followup)."""
    return {
        "scores": {
            "clarity": 75,
            "accuracy": 70,
            "practicality": 70,
            "depth": 65,
            "completeness": 70,
        },
        "overallScore": 71,
        "briefFeedback": "Mock 평가 — 잘한 점과 보완할 점이 균형 있게 드러났습니다.",
        "detailedFeedback": "Mock 상세 피드백입니다. 핵심을 잘 짚었고, 더 깊은 트레이드오프 설명이 있었다면 좋았을 것입니다.",
        "modelAnswer": "Mock 모범 답안입니다. 실제 면접에서는 이렇게 답변하시면 좋습니다.",
        "followUpQuestion": "그 결정의 트레이드오프는 무엇이었나요?",
    }


def _question_shape() -> dict[str, Any]:
    return {
        "question": "Mock 질문: 이 프로젝트에서 가장 중요한 기술적 의사결정과 그 근거를 설명해주세요.",
        "targetArea": "Mock 영역",
        "difficulty": "medium",
        "intent": "Mock intent",
    }


def _followup_shape() -> dict[str, Any]:
    return {
        "question": "Mock 꼬리질문: 방금 말씀하신 선택의 트레이드오프는 무엇이었나요?",
        "intent": "Mock followup intent",
    }


def _decide_shape() -> dict[str, Any]:
    return {"action": "next_topic", "reason": "Mock decision."}


def _fit_shape() -> dict[str, Any]:
    return {"avoid_topics": []}


def _profile_insight_shape() -> dict[str, Any]:
    return {
        "strengths": ["Mock 강점"],
        "weaknesses": ["Mock 약점"],
        "patterns": [],
    }


def _report_shape() -> dict[str, Any]:
    """Shape for REPORT_PROMPT — most fields overwritten server-side from aggregate."""
    return {
        "overallScore": 70,
        "summary": "Mock 종합 평가입니다. 전반적으로 핵심을 짚었으며 구체적 사례를 통해 실무 경험을 잘 드러냈습니다.",
        "strengths": [
            {"text": "Mock 강점 — 구체적 사례 제시", "questionRefs": [1]},
        ],
        "improvements": [
            {"text": "Mock 개선점 — 트레이드오프 설명 보강 필요", "questionRefs": [1]},
        ],
        "growthNotes": None,
        "recommendations": ["Mock 학습 키워드 1", "Mock 학습 키워드 2"],
        "questionHighlights": {
            "best": {"qIdx": 1, "reason": "Mock best reason"},
            "worst": {"qIdx": 1, "reason": "Mock worst reason"},
        },
        "phaseInsight": "Mock phase insight.",
        "technicalDiagnosis": {
            "strongTopics": [{"keyword": "Mock topic", "evidence": "Q1"}],
            "weakTopics": [
                {"keyword": "Mock weak topic", "reason": "Mock reason", "studyHint": "Mock study hint"}
            ],
        },
    }


def _seed_curriculum_shape() -> dict[str, Any]:
    return {
        "nodes": [
            {
                "title": "Mock 기초 개념",
                "description": "Mock 기초 개념 설명입니다.",
                "depth_level": 0,
                "parent_title": None,
                "keywords": ["mock", "basics"],
            },
            {
                "title": "Mock 응용 개념",
                "description": "Mock 응용 개념 설명입니다.",
                "depth_level": 1,
                "parent_title": "Mock 기초 개념",
                "keywords": ["mock", "applied"],
            },
        ]
    }


def _session_summary_shape() -> dict[str, Any]:
    return {
        "summary": "Mock 세션 요약입니다. 오늘 학습을 마쳤습니다.",
        "highlights": {
            "headline": "오늘의 학습 완료",
            "learned": [],
            "improved": [],
        },
        "voice_briefing": "Mock 음성 브리핑입니다. 오늘도 수고하셨어요.",
    }


def _resume_parse_shape() -> dict[str, Any]:
    return {
        "summary": "Mock resume summary.",
        "skills": ["Python", "FastAPI", "PostgreSQL"],
        "projects": [
            {
                "name": "Mock Project",
                "description": "Mock project description.",
                "techStack": ["Python", "FastAPI"],
                "role": "Backend",
                "period": "2024",
            }
        ],
        "experience": [],
        "education": [],
    }


def _job_posting_parse_shape() -> dict[str, Any]:
    return {
        "position": "Mock Position",
        "company": "Mock Co",
        "requirements": ["Mock requirement"],
        "responsibilities": ["Mock responsibility"],
        "requiredSkills": ["Python", "FastAPI"],
        "techStack": ["Python", "FastAPI"],
    }


def _matching_shape() -> dict[str, Any]:
    return {
        "matchedSkills": ["Python", "FastAPI"],
        "missingSkills": [],
        "matchScore": 80,
        "summary": "Mock matching summary.",
    }


def _model_answer_questions_shape() -> dict[str, Any]:
    return {
        "questions": [
            {
                "text": "Mock 질문 1",
                "modelAnswer": "Mock 모범 답안 1입니다.",
                "category": "general",
                "difficulty": "medium",
            }
        ]
    }


def _question_plan_shape() -> dict[str, Any]:
    return {
        "type": "TECHNICAL",
        "categories": ["general"],
        "difficulty": "INTERMEDIATE",
        "totalQuestions": 5,
        "reasoning": "Mock plan reasoning.",
    }


def _legacy_question_gen_shape() -> dict[str, Any]:
    return {
        "questions": [
            {
                "text": f"Mock 질문 {i + 1}: 본인의 경험을 설명해주세요.",
                "category": "general",
                "difficulty": "medium",
                "source": "general",
            }
            for i in range(5)
        ]
    }


def _planner_decision_shape() -> dict[str, Any]:
    """For INTERVIEW_PLANNER_PROMPT (search_profile/evaluate/decide)."""
    return {"action": "evaluate", "search_query": "", "reason": "Mock planner decision."}


def _shape_for_json(prompt: str) -> dict | list:
    """Pick a canned JSON shape based on keywords in the prompt.

    ORDER MATTERS — most specific keywords first.
    """
    p = prompt

    # --- Interview agent (backend/app/prompts/agent.py) ---
    if "실제 면접관이 이력서에서 보는 7가지 신호" in p or "scan_suggester" in p:
        return {
            "candidates": [
                {
                    "project_ref": f"Mock 프로젝트 {i+1}",
                    "score": 90 - i * 10,
                    "signals": ["jd_match", "impact"] if i < 2 else ["jd_unmatched", "complexity"],
                    "rationale": "Mock rationale.",
                    "probe_hint": "Mock probe.",
                    "query": f"Mock 프로젝트 {i+1} 쿼리",
                }
                for i in range(5)
            ]
        }
    if "INTERVIEW_PLANNER" in p or ("search_profile" in p and "evaluate" in p and "decide" in p):
        return _planner_decision_shape()
    if "딥다이브 주제 진행 판정" in p or ('"dig_deeper"' in p and '"next_topic"' in p):
        return _decide_shape()
    if "꼬리질문" in p:
        return _followup_shape()
    # 더 구체적인 builder들을 먼저 검사. fit은 마지막 fallback으로 둬야 question/eval/report의
    # variable 슬롯 안에 들어간 "avoid_topics"가 잘못 매칭되는 것을 막을 수 있다.
    if "면접 질문" in p and "지원자 답변" in p and "demonstratedKeywords" in p:
        return _agent_evaluation_shape()
    if "종합 리포트를 생성" in p or "questionHighlights" in p or "면접 종합 리포트 생성기" in p:
        return _report_shape()
    if "다음 질문 1개를 생성" in p or "current_topic_plan" in p or "현재 주제 플랜" in p or "다음 면접 질문 1개를 생성" in p:
        return _question_shape()
    if "면접 설계 전문가" in p:
        return _fit_shape()
    if "프로필 인사이트를 추출" in p:
        return _profile_insight_shape()

    # --- Learning coach ---
    if "학습 커리큘럼을 설계" in p or '"nodes"' in p and "depth_level" in p:
        return _seed_curriculum_shape()
    if "학습 세션을 정리" in p or "voice_briefing" in p:
        return _session_summary_shape()

    # --- Legacy evaluation pipeline ---
    if "지원자 답변" in p and "scores" in p and ("가중치" in p or "weighted" in p.lower()):
        return _legacy_eval_shape()

    # --- Resume / JD / matching / model answer ---
    if "이력서" in p and ("parsedData" in p or "resumeText" in p or "summary" in p and "skills" in p and "projects" in p):
        return _resume_parse_shape()
    if "채용공고" in p and ("requiredSkills" in p or "techStack" in p or "responsibilities" in p):
        return _job_posting_parse_shape()
    if "matchScore" in p or "matchedSkills" in p:
        return _matching_shape()
    if "modelAnswer" in p and "questions" in p:
        return _model_answer_questions_shape()

    # --- Legacy question pipeline ---
    if "면접 질문을 생성" in p or "QUESTION_GENERATION" in p or "questions" in p and "category" in p and "difficulty" in p:
        return _legacy_question_gen_shape()
    if "totalQuestions" in p and "categories" in p and "reasoning" in p:
        return _question_plan_shape()

    logger.warning("llm_mock: unmatched prompt prefix=%s", p[:160].replace("\n", " "))
    return {"result": "mock"}


# ---------------------------------------------------------------------------
# Public mock entry points (mirror llm_client signatures)
# ---------------------------------------------------------------------------

def _resolve_prompt(prompt: str | None, kwargs: dict[str, Any]) -> str:
    """call_llm*의 새 슬롯(cached_context/variable)을 mock 분기에서 단일 문자열로 합친다.

    실제 클라이언트와 동일한 의미를 유지: stable_prefix + variable. 키워드 dispatch는
    합쳐진 텍스트 안에서 동작한다.
    """
    if prompt:
        return prompt
    parts = [kwargs.get("system") or "", kwargs.get("cached_context") or "", kwargs.get("variable") or ""]
    return "\n".join(p for p in parts if p)


async def call_llm(prompt: str | None = None, **kwargs: Any) -> str:
    _resolve_prompt(prompt, kwargs)  # 일관성 유지를 위해 호출만
    return "Mocked response."


async def call_llm_json(prompt: str | None = None, **kwargs: Any) -> dict | list:
    return _shape_for_json(_resolve_prompt(prompt, kwargs))


async def call_llm_stream(prompt: str | None = None, **kwargs: Any) -> AsyncIterator[str]:
    _resolve_prompt(prompt, kwargs)
    for chunk in ["Mocked", " response", "."]:
        await asyncio.sleep(0.01)
        yield chunk


async def call_llm_vision(prompt: str, image_data_url: str, **kwargs: Any) -> str:
    return "Mocked vision response."


# ---------------------------------------------------------------------------
# Embedding mock — deterministic 1536-dim unit vector seeded by SHA-256
# ---------------------------------------------------------------------------

EMBED_DIM = 1536


def mock_embedding(text: str) -> list[float]:
    """Deterministic 1536-dim unit vector seeded by sha256(text)."""
    digest = hashlib.sha256((text or "").encode("utf-8")).digest()
    floats: list[float] = []
    while len(floats) < EMBED_DIM:
        for b in digest:
            floats.append((b - 127.5) / 127.5)
            if len(floats) >= EMBED_DIM:
                break
        digest = hashlib.sha256(digest).digest()
    norm = math.sqrt(sum(f * f for f in floats)) or 1.0
    return [f / norm for f in floats]
