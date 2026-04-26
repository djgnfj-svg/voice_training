"""각 LLM 호출 태그별 stable_prefix(=cached_context)의 토큰 수를 점검.

OpenAI 자동 프롬프트 캐시는 prefix가 ≥1024 토큰일 때만 적중한다. 이 스크립트는
대표 fixture로 stable_prefix를 빌드해 tiktoken으로 길이를 잰다.

사용:
  python scripts/check_prefix_tokens.py
종료 코드 0 = 모든 prefix ≥1024, 1 = 한 개라도 미달.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

_THIS = Path(__file__).resolve()
_BACKEND = _THIS.parent.parent
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

import tiktoken  # noqa: E402

from app.prompts.agent import (  # noqa: E402
    build_evaluation_messages,
    build_fit_messages,
    build_question_messages,
    build_report_messages,
)
from app.prompts.learning_coach import AGENTIC_SYSTEM_PROMPT  # noqa: E402

FIXTURES = _THIS.parent / "fixtures"
THRESHOLD = 1024


def _enc():
    # gpt-4o-mini는 cl100k 계열을 쓰지만 정확 매핑은 o200k_base. 둘 다 근사치 OK.
    try:
        return tiktoken.encoding_for_model("gpt-4o-mini")
    except KeyError:
        return tiktoken.get_encoding("o200k_base")


def _count(enc, text: str) -> int:
    return len(enc.encode(text))


def _resume_jd_fixtures() -> tuple[dict, dict]:
    resume = json.loads((FIXTURES / "resume.json").read_text(encoding="utf-8"))
    jd = json.loads((FIXTURES / "job_posting.json").read_text(encoding="utf-8"))
    return resume, jd


def _question_prefix() -> str:
    resume, jd = _resume_jd_fixtures()
    stable, _ = build_question_messages(
        summary=resume.get("summary", ""),
        skills=", ".join(resume.get("skills") or []),
        job_posting=json.dumps(jd, ensure_ascii=False, indent=2),
        strengths="(없음)",
        weaknesses="(없음)",
        patterns="(없음)",
        # variable 슬롯에 들어가는 값은 prefix 측정엔 영향 없음
        resume_chunks="",
        current_topic_plan="",
        conversation_history="",
        avoid_topics="",
    )
    return stable


def _evaluation_prefix() -> str:
    stable, _ = build_evaluation_messages(
        question="",
        answer="",
        strengths="(없음)",
        weaknesses="(없음)",
        conversation_history="",
    )
    return stable


def _report_prefix() -> str:
    stable, _ = build_report_messages(
        aggregate_block="",
        conversation_history="",
        strengths="(없음)",
        weaknesses="(없음)",
    )
    return stable


def _fit_prefix() -> str:
    stable, _ = build_fit_messages(
        resume_brief="",
        jd_brief="",
        matched="",
        gap="",
    )
    return stable


def _learning_coach_prefix() -> str:
    # bench_cache scenario B와 동일한 prefix 구성
    ctx = json.dumps(
        {
            "goal_title": "운영체제 기초",
            "turn_count": 0,
            "weak_nodes": [{"title": "프로세스/스레드"}, {"title": "동기화 기법"}],
        },
        ensure_ascii=False,
    )
    return (
        AGENTIC_SYSTEM_PROMPT
        + "\n\n# Session context (불변)\nContext JSON:\n"
        + ctx
        + "\n\n출력 스키마: {\"plan\": string, \"action\": string, \"next\": string}\n"
    )


def main() -> int:
    enc = _enc()
    prefixes = {
        "interview.questioner.scan_question/dive_question": _question_prefix(),
        "interview.evaluation.evaluate_answer": _evaluation_prefix(),
        "interview.evaluation.final_report": _report_prefix(),
        "interview.fit_analysis": _fit_prefix(),
        "learning_coach.bench_step": _learning_coach_prefix(),
    }
    fail = 0
    print(f"{'tag':<55} {'tokens':>7}  status")
    print("-" * 80)
    for tag, text in prefixes.items():
        n = _count(enc, text)
        status = "OK" if n >= THRESHOLD else f"FAIL (<{THRESHOLD})"
        if n < THRESHOLD:
            fail += 1
        print(f"{tag:<55} {n:>7}  {status}")
    return 1 if fail else 0


if __name__ == "__main__":
    sys.exit(main())
