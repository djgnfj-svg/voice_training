"""TTS TTFA (Time To First Audio byte) 측정.

backend 컨테이너 내부에서 실행하여 voice_training-tts-1 의 /synthesize 를 호출.
스트리밍이 켜져 있으면 첫 바이트까지의 시간이 전체 gen 시간보다 훨씬 짧게 측정됨.

사용법:
    docker exec voice_training-backend-1 python /app/../scripts/measure_ttfa.py
또는 프로젝트 루트에서:
    docker compose exec backend python -c "import sys;sys.path.insert(0,'/scripts');..."

간편하게는 scripts를 볼륨 마운트 없이 curl로도 측정 가능.
"""
from __future__ import annotations

import asyncio
import os
import statistics
import time

import httpx

TTS_URL = "http://tts:8080/synthesize"
REPEATS = 3
FMT = os.environ.get("FMT", "opus")

SAMPLES = [
    ("short (27자)", "안녕하세요. 오늘 면접에 참여해주셔서 감사합니다."),
    (
        "medium (63자)",
        "자기소개를 부탁드립니다. 본인의 경력과 강점, 그리고 이번 포지션에 관심을 가지게 된 계기를 편하게 말씀해주세요.",
    ),
    (
        "long (129자)",
        "React 에서 컴포넌트 리렌더링을 최적화하기 위해 사용하는 memo, useMemo, useCallback 의 차이를 설명해주시고, 실제 프로젝트에서 어떤 상황에 각각을 선택하셨는지 구체적인 예시와 함께 말씀해 주시면 좋겠습니다.",
    ),
]


async def measure_once(text: str) -> tuple[float, float, int]:
    """Return (ttfa_s, total_s, bytes)."""
    async with httpx.AsyncClient(timeout=60.0) as client:
        t0 = time.perf_counter()
        req = client.build_request("POST", TTS_URL, json={"text": text, "format": FMT})
        resp = await client.send(req, stream=True)
        resp.raise_for_status()
        ttfa = None
        total_bytes = 0
        async for chunk in resp.aiter_raw():
            if ttfa is None and chunk:
                ttfa = time.perf_counter() - t0
            total_bytes += len(chunk)
        await resp.aclose()
        total = time.perf_counter() - t0
        return ttfa or total, total, total_bytes


async def main():
    print(f"== format={FMT} ==")
    print(f"{'label':<18} {'ttfa_s':>8} {'total_s':>8} {'bytes':>8}")
    for label, text in SAMPLES:
        ttfas: list[float] = []
        totals: list[float] = []
        size = 0
        for _ in range(REPEATS):
            ttfa, total, nbytes = await measure_once(text)
            ttfas.append(ttfa)
            totals.append(total)
            size = nbytes
        print(
            f"{label:<18} {statistics.mean(ttfas):>8.3f} {statistics.mean(totals):>8.3f} {size:>8}"
        )


if __name__ == "__main__":
    asyncio.run(main())
