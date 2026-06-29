"""measure_jd_coverage.py — AI 코치 면접 'JD 커버리지' 측정 하니스.

JD 루브릭 커버리지(C안) 재설계의 before/after 비교용 측정 도구이자 산출물.

동작:
  - 고정 fixture(scripts/fixtures/resume.json + job_posting.json) 1쌍을 사용.
  - app.agent.interview.graph 의 노드/라우팅 함수를 **in-memory**로 직접 구동
    (HTTP 아님, DB 영속화/쓰기 없음, load_profile/update_profile/generate_report 미호출).
  - canned 답변 3개를 순환하며 start(fit→rubric_plan→rubric_ask) + answer 루프를 끝까지 진행,
    생성된 모든 질문(JD 루브릭 커버리지)을 수집.
  - 비결정적(실 LLM)이므로 --runs N회 실행 후 개별값 + 평균을 보고.

산출 지표:
  1. jd_ref_ratio_all  (헤드라인): JD requiredSkills ∪ requirements/responsibilities 키워드를
     1개 이상 직접 포함한 질문 수 / 전체 질문 수.
  2. jd_ref_ratio_skills_only: requiredSkills 토큰만으로 같은 비율 (보조 지표).
  3. rubric_item_coverage: JD 요구항목(requirements+responsibilities) N개 중
     질문이 직접 다룬 항목 수/비율 (build_rubric_plan이 추출한 루브릭 기준).
  4. llm_calls_per_session: 세션당 실제 LLM 호출 수(tag별). report/update_profile 제외.

사용 (prod 백엔드 컨테이너 내부, 실 OpenAI):
  docker cp backend/scripts/measure_jd_coverage.py voiceprep-prod-backend-1:/app/scripts/
  docker cp backend/scripts/fixtures voiceprep-prod-backend-1:/app/scripts/
  docker exec voiceprep-prod-backend-1 sh -c \
    'cd /app && python scripts/measure_jd_coverage.py --runs 3'

주의:
  - E2E_MOCK_LLM 이 설정돼 있으면 안 됨(실 질문 생성이 필요).
  - DB 미접속(db=None) — resume_id/has_resume_embeddings 미설정으로 RAG/프로필 경로는 우회.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import re
import sys
import tempfile
from pathlib import Path
from typing import Any

# `python scripts/measure_jd_coverage.py` / `python -m scripts...` 양쪽 지원
_THIS = Path(__file__).resolve()
_BACKEND = _THIS.parent.parent
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

FIXTURES = _THIS.parent / "fixtures"

# 메트릭 info 라인이 stdout 을 오염시키지 않도록 WARNING 이상만.
logging.basicConfig(level=logging.WARNING)

# 세션당 canned 답변 (현실적인 백엔드 답변, 루브릭 커버리지 전반 순환 사용)
CANNED_ANSWERS = [
    "FastAPI 기반으로 색인 파이프라인을 비동기화했고 Redis로 핫 캐시 계층을 두어 p95를 250ms로 "
    "맞췄습니다. 인덱싱 지연은 Bulk API 배치 사이즈 튜닝과 백프레셔로 30분에서 2분으로 줄였습니다.",
    "Kafka 토픽을 도메인 단위로 쪼개고 Outbox 패턴으로 트랜잭션 일관성을 유지했습니다. 컨슈머 "
    "그룹별 SLA를 정의해 모니터링했고, 재배포 시간을 40분에서 5분으로 단축했습니다.",
    "Airflow DAG로 일/월 정산을 자동화했고, idempotent task 설계 + checkpoint 재시도로 정산 "
    "오차를 0.3%에서 0.001%까지 줄였습니다.",
]

# JD 키워드 추출 시 제외할 일반어(직접 참조로 보기엔 너무 범용). 매칭 변별력 확보용.
KOR_STOP = {
    "경험", "이상", "능력", "업무", "작업", "활용", "이해", "대한", "위한", "통한", "관련",
    "개발", "설계", "처리", "서비스", "운영", "도구", "관리", "핵심", "플랫폼", "구축",
    "담당", "수행", "지원", "기반", "시스템", "구조", "방식", "환경",
}


def _load_fixture(name: str) -> dict:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def _normalize(s: str) -> str:
    return re.sub(r"[ .\-]", "", str(s).lower())


def _phrase_keywords(phrase: str) -> list[str]:
    """한 요구항목 문구에서 변별력 있는 키워드(영문 len>=3 / 한글 len>=2, 불용어 제외) 추출."""
    kws: set[str] = set()
    for m in re.findall(r"[A-Za-z]{3,}", phrase):
        kws.add(m.lower())
    cleaned = re.sub(r"[()/,]", " ", phrase)
    for w in re.findall(r"[가-힣]{2,}", cleaned):
        if w not in KOR_STOP:
            kws.add(w)
    return sorted(kws)


def extract_jd_tokens(jd: dict) -> dict[str, list[str]]:
    skills = [str(s) for s in (jd.get("requiredSkills") or []) if s]
    kw: set[str] = set()
    for field in ("requirements", "responsibilities"):
        for phrase in jd.get(field) or []:
            kw.update(_phrase_keywords(str(phrase)))
    return {"skills": skills, "requirement_keywords": sorted(kw)}


def jd_items(jd: dict) -> list[dict]:
    """루브릭 근사: requirements + responsibilities 각 항목 + 자기 키워드."""
    items: list[dict] = []
    for field in ("requirements", "responsibilities"):
        for phrase in jd.get(field) or []:
            items.append({"item": str(phrase), "keywords": _phrase_keywords(str(phrase))})
    return items


def question_matches(question: str, tokens: dict[str, list[str]]) -> dict[str, list[str]]:
    qlower = question.lower()
    qnorm = _normalize(question)
    skill_hits = [sk for sk in tokens["skills"] if _normalize(sk) and _normalize(sk) in qnorm]
    kw_hits = [kw for kw in tokens["requirement_keywords"] if kw in qlower]
    return {"skills": skill_hits, "keywords": kw_hits}


def item_covered(item: dict, questions: list[str]) -> bool:
    if not item["keywords"]:
        return False
    joined = " ".join(questions).lower()
    return any(kw in joined for kw in item["keywords"])


# ---------------------------------------------------------------------------
# In-memory session driver (graph 노드/라우팅 함수 직접 구동)
# ---------------------------------------------------------------------------

async def run_session(resume: dict, jd: dict, max_questions: int = 9) -> dict[str, Any]:
    from app.agent.interview import graph

    state: dict[str, Any] = {
        "session_id": "measure",
        "user_id": "measure",
        "resume": resume,
        "job_posting": jd,
        "user_profile": {"strengths": [], "weaknesses": [], "patterns": [], "context": []},
        "conversation_history": [],
        "pending_events": [],
        "actions_taken": [],
        "question_count": 0,
        "max_questions": max_questions,
        "current_rubric_idx": 0,
        "current_item_depth": 0,
    }

    # start 경로 (load_profile 은 DB 의존이라 생략 — 빈 user_profile 사용)
    state = await graph.fit_analysis(state, None)
    state = await graph.build_rubric_plan(state, None)
    state = await graph.rubric_ask(state, None)

    questions: list[dict] = []

    def _record(st: dict) -> None:
        q = st.get("current_question")
        if not q:
            return
        rp = st.get("rubric_plan") or []
        idx = st.get("current_rubric_idx", 0)
        item = rp[idx] if 0 <= idx < len(rp) else {}
        phase = "evidence" if item.get("has_evidence") else "gap"
        questions.append({"question": q, "phase": phase})

    _record(state)

    turn = 0
    while turn < 40:
        if not state.get("current_question"):
            break
        # 답변 주입 후 평가
        state = dict(state)
        state["current_answer"] = CANNED_ANSWERS[turn % len(CANNED_ANSWERS)]
        state.pop("current_evaluation", None)
        state = await graph.evaluate_answer(state, None)
        state = await graph.coverage_next(state, None)
        state = graph.enforce_question_cap(state)

        if state.get("next_action") == "rubric_ask":
            state = await graph.rubric_ask(state, None)
        else:
            break

        _record(state)
        turn += 1

    return {
        "questions": questions,
        "rubric_labels": [it.get("label") for it in (state.get("rubric_plan") or [])],
        "coverage": state.get("coverage") or [],
    }


def _parse_llm_metrics(path: Path) -> list[dict]:
    if not path.exists():
        return []
    out: list[dict] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        if obj.get("event") == "llm_call":
            out.append(obj)
    return out


def _analyze_run(session: dict, tokens: dict, items: list[dict], llm_calls: list[dict]) -> dict:
    questions = session["questions"]
    q_texts = [q["question"] for q in questions]
    total_q = len(q_texts)

    per_q = []
    all_hit = 0
    skills_hit = 0
    for q in questions:
        m = question_matches(q["question"], tokens)
        any_all = bool(m["skills"] or m["keywords"])
        any_skill = bool(m["skills"])
        all_hit += int(any_all)
        skills_hit += int(any_skill)
        per_q.append({
            "phase": q["phase"],
            "question": q["question"],
            "matched_skills": m["skills"],
            "matched_keywords": m["keywords"],
            "jd_ref": any_all,
        })

    covered_items = [it["item"] for it in items if item_covered(it, q_texts)]

    by_tag: dict[str, int] = {}
    for c in llm_calls:
        by_tag[c.get("tag") or "untagged"] = by_tag.get(c.get("tag") or "untagged", 0) + 1

    return {
        "total_questions": total_q,
        "jd_ref_questions_all": all_hit,
        "jd_ref_ratio_all": round(all_hit / total_q, 4) if total_q else None,
        "jd_ref_questions_skills_only": skills_hit,
        "jd_ref_ratio_skills_only": round(skills_hit / total_q, 4) if total_q else None,
        "rubric_items_total": len(items),
        "rubric_items_covered": len(covered_items),
        "rubric_coverage_ratio": round(len(covered_items) / len(items), 4) if items else None,
        "covered_items": covered_items,
        "llm_calls_total": len(llm_calls),
        "llm_calls_by_tag": by_tag,
        "rubric_labels": session.get("rubric_labels", []),
        "coverage": session.get("coverage", []),
        "per_question": per_q,
    }


def _question_prompt_tokens(resume: dict, jd: dict) -> dict:
    """build_question_messages 조립 후 tiktoken 인코딩 길이 (첫 루브릭 질문 기준, 결정적)."""
    try:
        import tiktoken

        from app.agent.interview import questioner
        from app.prompts.agent import build_question_messages

        enc = tiktoken.encoding_for_model("gpt-4o-mini")
        rubric_item = {
            "id": "r1",
            "label": "핵심 직무 역량",
            "jd_requirement": "JD 핵심 요구역량",
            "importance": "must",
            "has_evidence": True,
            "evidence_refs": [],
            "query": "핵심 직무 역량",
        }
        profile_str = questioner._format_profile({})
        history_str = questioner._format_history([])
        job_str = json.dumps(jd, ensure_ascii=False, indent=2)
        plan_str = questioner._format_rubric_plan(rubric_item, 0, 3)
        stable, variable = build_question_messages(
            summary=resume.get("summary", ""),
            skills=", ".join(str(s) for s in (resume.get("skills") or [])),
            job_posting=job_str,
            strengths=profile_str["strengths"],
            weaknesses=profile_str["weaknesses"],
            patterns=profile_str["patterns"],
            resume_chunks="(청크 없음)",
            current_topic_plan=plan_str,
            conversation_history=history_str,
            avoid_topics="(없음)",
        )
        stable_tok = len(enc.encode(stable))
        var_tok = len(enc.encode(variable))
        return {
            "stable_tokens": stable_tok,
            "variable_tokens": var_tok,
            "total_tokens": stable_tok + var_tok,
            "basis": "first rubric question, empty profile/history, no resume chunks",
            "error": None,
        }
    except Exception as exc:  # noqa: BLE001
        return {"stable_tokens": None, "variable_tokens": None, "total_tokens": None, "error": str(exc)}


async def main_async(runs: int) -> dict:
    resume = _load_fixture("resume.json")
    jd = _load_fixture("job_posting.json")
    tokens = extract_jd_tokens(jd)
    items = jd_items(jd)

    run_results: list[dict] = []
    for i in range(runs):
        with tempfile.NamedTemporaryFile(suffix=f".m{i}.jsonl", delete=False) as tf:
            metrics_path = Path(tf.name)
        os.environ["LLM_METRICS_FILE"] = str(metrics_path)
        try:
            session = await run_session(resume, jd)
        finally:
            calls = _parse_llm_metrics(metrics_path)
            os.environ.pop("LLM_METRICS_FILE", None)
            try:
                metrics_path.unlink()
            except OSError:
                pass
        run_results.append(_analyze_run(session, tokens, items, calls))

    def _avg(key: str) -> float | None:
        vals = [r[key] for r in run_results if r.get(key) is not None]
        return round(sum(vals) / len(vals), 4) if vals else None

    aggregate = {
        "runs": runs,
        "jd_ref_ratio_all_avg": _avg("jd_ref_ratio_all"),
        "jd_ref_ratio_skills_only_avg": _avg("jd_ref_ratio_skills_only"),
        "rubric_coverage_ratio_avg": _avg("rubric_coverage_ratio"),
        "total_questions_avg": _avg("total_questions"),
        "llm_calls_total_avg": _avg("llm_calls_total"),
        "jd_ref_ratio_all_per_run": [r["jd_ref_ratio_all"] for r in run_results],
        "jd_ref_ratio_skills_only_per_run": [r["jd_ref_ratio_skills_only"] for r in run_results],
        "rubric_coverage_ratio_per_run": [r["rubric_coverage_ratio"] for r in run_results],
        "total_questions_per_run": [r["total_questions"] for r in run_results],
        "llm_calls_total_per_run": [r["llm_calls_total"] for r in run_results],
    }

    return {
        "jd_tokens": tokens,
        "jd_items": [it["item"] for it in items],
        "question_prompt_tokens": _question_prompt_tokens(resume, jd),
        "aggregate": aggregate,
        "runs_detail": run_results,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument("--out", type=str, default="")
    args = parser.parse_args()

    result = asyncio.run(main_async(args.runs))
    blob = json.dumps(result, ensure_ascii=False, indent=2)
    if args.out:
        Path(args.out).write_text(blob, encoding="utf-8")
    print("===RESULT_JSON_START===")
    print(blob)
    print("===RESULT_JSON_END===")


if __name__ == "__main__":
    main()
