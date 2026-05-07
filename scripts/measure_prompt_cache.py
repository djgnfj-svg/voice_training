"""Measure OpenAI automatic prompt cache hit ratio for a typical agent-interview session.

Simulates Scan(3) + Dive(4) = 7 question-generation calls sharing the same
system + cached_context prefix (resume + JD + persona/rubric).

Run from backend container:
  docker compose exec -e E2E_MOCK_LLM=0 backend python /work/measure_prompt_cache.py
"""
import asyncio
import json
import os
import sys
import time

os.environ["E2E_MOCK_LLM"] = "0"

sys.path.insert(0, "/app")

from openai import AsyncOpenAI

MODEL = os.environ.get("AGENT_MODEL", "gpt-4o-mini")

# Long static prefix (>1024 tokens) — persona + rubric + resume + JD.
SYSTEM = (
    "You are a senior software engineering interviewer for a Korean startup. "
    "Generate one focused technical question per turn. Output JSON only."
) * 4

CACHED_CONTEXT = (
    "## Rubric\n"
    "- clarity 30%, accuracy 25%, practicality 25%, depth 15%, completeness 5%.\n"
    "- Reject filler answers; cap low-effort responses at 40.\n"
    "## Persona\n"
    "- Korean, polite-but-direct senior interviewer. Avoid yes/no questions.\n"
    "## Resume (chunked summary)\n"
    + ("- 5y backend engineer. Python/FastAPI/Postgres/Redis. Built a real-time chat "
       "service handling 10k concurrent users. Migrated monolith to microservices. "
       "Led pgvector RAG project for resume search. Strong in distributed systems, "
       "weak in frontend. Owns SLO definition and oncall rotation. ") * 8
    + "\n## Job Posting\n"
    + ("Senior backend engineer. Required: FastAPI, Postgres, async I/O, pgvector or "
       "vector DB experience. Plus: LangGraph/agent systems, observability, K8s. ") * 6
    + "\n## Scan Plan\n"
    + json.dumps({
        "phase": "scan",
        "topics": [
            {"project_ref": "real-time chat", "techStack": ["python", "websocket", "redis"]},
            {"project_ref": "pgvector RAG", "techStack": ["postgres", "pgvector", "openai"]},
            {"project_ref": "monolith→microservice migration", "techStack": ["docker", "k8s"]},
        ],
    }, ensure_ascii=False)
)

VARIABLE_TURNS = [
    "현재 phase=scan, scan_idx=0. 첫 질문 생성.",
    "현재 phase=scan, scan_idx=1. 답변 depth=72였음. 다음 주제로.",
    "현재 phase=scan, scan_idx=2. 답변 depth=58. 다음 주제.",
    "현재 phase=dive, topic=pgvector RAG, depth=1. 약점 파고들기 시작.",
    "현재 phase=dive, topic=pgvector RAG, depth=2. 직전 답변 depth=55, 더 파기.",
    "현재 phase=dive, topic=real-time chat, depth=1. 강점 검증.",
    "현재 phase=dive, topic=real-time chat, depth=2. 직전 답변 depth=82, 마지막 질문.",
]


async def main() -> None:
    client = AsyncOpenAI()
    totals = {"prompt": 0, "cached": 0, "completion": 0}
    rows = []
    for i, var in enumerate(VARIABLE_TURNS):
        messages = [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": CACHED_CONTEXT},
            {"role": "assistant", "content": "Understood. Ready for turn-specific input."},
            {"role": "user", "content": var + "\nReturn JSON: {\"question\": str}"},
        ]
        t = time.perf_counter()
        resp = await client.chat.completions.create(
            model=MODEL,
            messages=messages,
            temperature=0.5,
            max_tokens=300,
            response_format={"type": "json_object"},
        )
        ms = int((time.perf_counter() - t) * 1000)
        u = resp.usage
        cached = getattr(getattr(u, "prompt_tokens_details", None), "cached_tokens", 0) or 0
        rows.append({
            "turn": i,
            "prompt": u.prompt_tokens,
            "cached": cached,
            "completion": u.completion_tokens,
            "ms": ms,
        })
        totals["prompt"] += u.prompt_tokens
        totals["cached"] += cached
        totals["completion"] += u.completion_tokens
        print(f"turn {i}: prompt={u.prompt_tokens} cached={cached} "
              f"completion={u.completion_tokens} {ms}ms")

    # gpt-4o-mini pricing (USD per 1M tokens, as of 2025): input $0.15, cached $0.075, output $0.60
    P_IN, P_CACHE, P_OUT = 0.15, 0.075, 0.60
    uncached_in = totals["prompt"] - totals["cached"]
    cost_with = (uncached_in * P_IN + totals["cached"] * P_CACHE + totals["completion"] * P_OUT) / 1_000_000
    cost_without = (totals["prompt"] * P_IN + totals["completion"] * P_OUT) / 1_000_000
    saving_pct = (1 - cost_with / cost_without) * 100 if cost_without else 0
    hit_ratio = totals["cached"] / totals["prompt"] * 100 if totals["prompt"] else 0

    print("\n=== TOTAL ===")
    print(f"prompt={totals['prompt']} cached={totals['cached']} completion={totals['completion']}")
    print(f"cache hit ratio (input): {hit_ratio:.1f}%")
    print(f"cost without cache: ${cost_without:.6f}")
    print(f"cost with cache:    ${cost_with:.6f}")
    print(f"session cost saving: {saving_pct:.1f}%")


if __name__ == "__main__":
    asyncio.run(main())
