"""LLM 캐시 효과 측정 벤치마크.

시나리오:
  A: agent interview 1세션 시뮬 — fit_analysis 1회 + scan question 3회 + evaluate 3회 + final report 1회
  B: learning_coach plan→action 3 step (system prompt 동일 반복으로 캐시 후보)

각 run마다 LLM_METRICS_FILE을 임시 파일로 새로 지정해 호출별 메트릭을 수집,
가격표를 적용해 cost/cache_hit_rate/ttft 분포를 집계한다.

사용:
  python -m backend.scripts.bench_cache --scenario A --runs 5 --out _workspace/02_baseline_metrics.json
  python -m backend.scripts.bench_cache --scenario B --runs 5 --out _workspace/02_baseline_metrics_B.json

주의:
  - 실제 OpenAI 호출이 발생하므로 비용 발생. E2E_MOCK_LLM이 설정돼 있으면 안 됨.
  - prefix 리팩터 전 baseline 측정 시 cache_hit_rate ≈ 0 예상 (정상).
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import statistics
import sys
import tempfile
import time
from collections import defaultdict
from pathlib import Path
from typing import Any

# Allow `python backend/scripts/bench_cache.py` invocation by ensuring backend/ on path
_THIS = Path(__file__).resolve()
_BACKEND = _THIS.parent.parent
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

FIXTURES = _THIS.parent / "fixtures"

# gpt-4o-mini 가격 (per 1M tokens, USD)
PRICE_INPUT = 0.15
PRICE_CACHED_INPUT = 0.075
PRICE_OUTPUT = 0.60


def _load_fixture(name: str) -> dict:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


# ---------------------------------------------------------------------------
# Scenarios
# ---------------------------------------------------------------------------

async def _scenario_A() -> None:
    """면접 1세션 시뮬: fit_analysis → scan질문×3 → 평가×3 → final_report.

    함수 직접 호출로 결정성 확보. DB는 건드리지 않음.
    """
    from app.agent.interview.fit_analysis import run_fit_analysis
    from app.agent.interview.questioner import generate_scan_question
    from app.agent.interview.evaluation import evaluate_answer, generate_report
    from app.agent.interview.state import ScanItem

    resume = _load_fixture("resume.json")
    jd = _load_fixture("job_posting.json")

    fit = await run_fit_analysis(resume, jd)
    avoid = fit.get("avoid_topics") or []

    user_profile = {"strengths": [], "weaknesses": [], "patterns": [], "context": []}
    history: list[dict] = []
    projects = resume.get("projects") or []
    answers = [
        "FastAPI 기반으로 색인 파이프라인을 비동기화했고 Redis로 핫 캐시 계층을 두어 p95를 250ms로 맞췄습니다. 인덱싱 지연은 Bulk API 배치 사이즈 튜닝과 백프레셔로 30분에서 2분으로 줄였습니다.",
        "Kafka 토픽을 도메인 단위로 쪼개고 Outbox 패턴으로 트랜잭션 일관성을 유지했습니다. 컨슈머 그룹별 SLA를 정의해 모니터링했고, 재배포 시간을 40분에서 5분으로 단축했습니다.",
        "Airflow DAG로 일/월 정산을 자동화했고, idempotent task 설계 + checkpoint 재시도로 정산 오차를 0.3%에서 0.001%까지 줄였습니다.",
    ]

    for i in range(3):
        proj = projects[i % len(projects)]
        scan_item: ScanItem = {
            "project_ref": proj["name"],
            "query": ", ".join(proj.get("techStack") or []),
            "reason": "jd_match" if i < 2 else "jd_unmatched",
        }
        q = await generate_scan_question(
            resume=resume,
            job_posting=jd,
            user_profile=user_profile,
            conversation_history=history,
            scan_item=scan_item,
            scan_idx=i,
            total_scans=3,
            resume_chunks=[{"content": proj.get("description", "")}],
            avoid_topics=avoid,
        )
        question_text = q.get("question") or q.get("text") or "다음 프로젝트의 핵심 기여를 설명해 주세요."
        answer = answers[i]
        evaluation = await evaluate_answer(
            question=question_text,
            answer=answer,
            user_profile=user_profile,
            conversation_history=history,
        )
        history.append({
            "question_number": i + 1,
            "question": question_text,
            "answer": answer,
            "evaluation": evaluation,
        })

    await generate_report(history, user_profile)


async def _scenario_B() -> None:
    """learning_coach plan→action 3 step 시뮬.

    실제 graph는 DB 의존이 커서 직접 호출 대신, 동일 시스템 프롬프트를 반복 사용하는
    plan/action 패턴을 call_llm_json으로 모사한다. 캐시 후보(같은 시스템 prefix 반복)를
    측정하기에 충분.
    """
    from app.lib.llm_client import call_llm_json
    from app.prompts.learning_coach import AGENTIC_SYSTEM_PROMPT

    ctx = json.dumps({
        "goal_title": "운영체제 기초",
        "turn_count": 0,
        "weak_nodes": [{"title": "프로세스/스레드"}, {"title": "동기화 기법"}],
    }, ensure_ascii=False)

    # 세션 동안 불변 prefix: 페르소나/정책 + 컨텍스트 JSON. 호출 간 동일 → 캐시 후보.
    stable_prefix = (
        AGENTIC_SYSTEM_PROMPT
        + "\n\n# Session context (불변)\nContext JSON:\n"
        + ctx
        + "\n\n출력 스키마: {\"plan\": string, \"action\": string, \"next\": string}\n"
    )

    utterances = [
        "오늘은 프로세스와 스레드 차이부터 다시 보고 싶어요.",
        "동기화 기법 중 뮤텍스랑 세마포어 차이를 잘 모르겠어요.",
        "데드락이 발생하는 4가지 조건을 설명해 줘요.",
    ]
    for utt in utterances:
        await call_llm_json(
            cached_context=stable_prefix,
            variable=f"사용자 발화: {utt}\n\n위 스키마 JSON으로만 응답하세요.",
            temperature=0.4,
            tag="learning_coach.bench_step",
        )


SCENARIOS = {"A": _scenario_A, "B": _scenario_B}


# ---------------------------------------------------------------------------
# Metric collection / aggregation
# ---------------------------------------------------------------------------

def _parse_metrics(path: Path) -> list[dict]:
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


def _percentile(values: list[float], p: float) -> float | None:
    if not values:
        return None
    s = sorted(values)
    k = (len(s) - 1) * p
    lo = int(k)
    hi = min(lo + 1, len(s) - 1)
    frac = k - lo
    return s[lo] + (s[hi] - s[lo]) * frac


def _summarize_calls(calls: list[dict]) -> dict[str, Any]:
    prompt_total = sum(c["prompt_tokens"] for c in calls)
    cached_total = sum(c["cached_tokens"] for c in calls)
    completion_total = sum(c["completion_tokens"] for c in calls)
    uncached = max(0, prompt_total - cached_total)
    billed_input = uncached + cached_total * 0.5
    cost = (
        uncached / 1_000_000 * PRICE_INPUT
        + cached_total / 1_000_000 * PRICE_CACHED_INPUT
        + completion_total / 1_000_000 * PRICE_OUTPUT
    )
    return {
        "calls": len(calls),
        "prompt_tokens": prompt_total,
        "cached_tokens": cached_total,
        "completion_tokens": completion_total,
        "billed_input_tokens": billed_input,
        "cache_hit_rate": (cached_total / prompt_total) if prompt_total else 0.0,
        "cost_usd": round(cost, 6),
    }


def _summarize_runs(runs: list[dict]) -> dict[str, Any]:
    if not runs:
        return {}
    totals = [r["totals"] for r in runs]
    avg = lambda key: statistics.mean(t[key] for t in totals)

    # tag별 ttft / latency 분포
    by_tag_ttft: dict[str, list[float]] = defaultdict(list)
    by_tag_latency: dict[str, list[float]] = defaultdict(list)
    for r in runs:
        for c in r["calls"]:
            tag = c.get("tag") or "(untagged)"
            if c.get("ttft_ms") is not None:
                by_tag_ttft[tag].append(float(c["ttft_ms"]))
            if c.get("latency_ms") is not None:
                by_tag_latency[tag].append(float(c["latency_ms"]))

    ttft_p50 = {k: _percentile(v, 0.5) for k, v in by_tag_ttft.items()}
    ttft_p95 = {k: _percentile(v, 0.95) for k, v in by_tag_ttft.items()}
    latency_p50 = {k: _percentile(v, 0.5) for k, v in by_tag_latency.items()}
    latency_p95 = {k: _percentile(v, 0.95) for k, v in by_tag_latency.items()}

    total_prompt = sum(t["prompt_tokens"] for t in totals)
    total_cached = sum(t["cached_tokens"] for t in totals)

    return {
        "runs": len(runs),
        "avg_calls_per_run": avg("calls"),
        "avg_prompt_tokens": avg("prompt_tokens"),
        "avg_cached_tokens": avg("cached_tokens"),
        "avg_completion_tokens": avg("completion_tokens"),
        "avg_billed_input": avg("billed_input_tokens"),
        "avg_cost_usd": round(avg("cost_usd"), 6),
        "cache_hit_rate": (total_cached / total_prompt) if total_prompt else 0.0,
        "ttft_p50_by_tag": ttft_p50,
        "ttft_p95_by_tag": ttft_p95,
        "latency_p50_by_tag": latency_p50,
        "latency_p95_by_tag": latency_p95,
    }


# ---------------------------------------------------------------------------
# Driver
# ---------------------------------------------------------------------------

async def _run_one(scenario: str, idx: int) -> dict[str, Any]:
    fn = SCENARIOS[scenario]
    tmp = Path(tempfile.mkstemp(prefix=f"llm_metrics_{scenario}_{idx}_", suffix=".jsonl")[1])
    os.environ["LLM_METRICS_FILE"] = str(tmp)
    try:
        started = time.perf_counter()
        await fn()
        wall_ms = int((time.perf_counter() - started) * 1000)
        calls = _parse_metrics(tmp)
        return {
            "index": idx,
            "wall_ms": wall_ms,
            "calls": calls,
            "totals": _summarize_calls(calls),
        }
    finally:
        os.environ.pop("LLM_METRICS_FILE", None)
        try:
            tmp.unlink()
        except OSError:
            pass


async def _main_async(args: argparse.Namespace) -> None:
    if os.environ.get("E2E_MOCK_LLM") == "1":
        print("ERROR: E2E_MOCK_LLM=1 — bench는 실제 OpenAI 호출이 필요합니다.", file=sys.stderr)
        sys.exit(2)

    runs: list[dict[str, Any]] = []
    for i in range(args.runs):
        print(f"[bench] scenario={args.scenario} run {i + 1}/{args.runs} ...", file=sys.stderr)
        result = await _run_one(args.scenario, i)
        print(
            f"  calls={result['totals']['calls']} "
            f"prompt={result['totals']['prompt_tokens']} "
            f"cached={result['totals']['cached_tokens']} "
            f"completion={result['totals']['completion_tokens']} "
            f"cost=${result['totals']['cost_usd']}",
            file=sys.stderr,
        )
        runs.append(result)

    output = {
        "scenario": args.scenario,
        "runs": runs,
        "summary": _summarize_runs(runs),
        "pricing": {
            "model_assumed": "gpt-4o-mini",
            "input_per_1m_usd": PRICE_INPUT,
            "cached_input_per_1m_usd": PRICE_CACHED_INPUT,
            "output_per_1m_usd": PRICE_OUTPUT,
        },
    }

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[bench] wrote {out_path}", file=sys.stderr)


def main() -> None:
    parser = argparse.ArgumentParser(description="Benchmark LLM call usage / caching.")
    parser.add_argument("--scenario", choices=list(SCENARIOS), required=True)
    parser.add_argument("--runs", type=int, default=5)
    parser.add_argument("--out", type=str, required=True)
    args = parser.parse_args()
    asyncio.run(_main_async(args))


if __name__ == "__main__":
    main()
