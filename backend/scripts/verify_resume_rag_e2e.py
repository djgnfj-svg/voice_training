"""end-to-end: 임베딩 → fit_analysis → search_resume까지 수동 검증.

실행: docker exec voice_training-backend-1 python -m scripts.verify_resume_rag_e2e
"""
from __future__ import annotations

import asyncio

from sqlalchemy import text

from app.agent.interview.fit_analyzer import run_fit_analysis
from app.agent.interview.resume_rag import embed_resume, has_resume_embeddings, search_resume
from app.database import async_session


async def main() -> None:
    async with async_session() as db:
        r = await db.execute(text('SELECT id, "userId", name, "parsedData" FROM resumes WHERE "parsedData"->\'projects\' IS NOT NULL LIMIT 1'))
        row = r.fetchone()
        if not row:
            print("no resume with projects; abort")
            return
        rid, uid, name, pd = row.id, row.userId, row.name, row.parsedData

    print(f"== Resume: {name} ({rid[:8]}) ==\n")

    n = await embed_resume(rid, uid, pd)
    print(f"[1] embed_resume → {n} chunks")

    async with async_session() as db:
        assert await has_resume_embeddings(db, rid), "expected embeddings present"
    print("[2] has_resume_embeddings → True")

    fa = await run_fit_analysis(pd, None)  # JD 없는 케이스
    print(f"[3] fit_analysis (JD=None):")
    print(f"    skill_match: {fa['skill_match']}")
    print(f"    focus_topics: {len(fa['focus_topics'])}건")
    for t in fa["focus_topics"]:
        print(f"      - [{t['priority']}] {t['topic']}")

    async with async_session() as db:
        for q in [
            "주요 프로젝트 경험",
            "성능 최적화",
            (fa["focus_topics"][0]["topic"] if fa["focus_topics"] else "팀 협업"),
        ]:
            res = await search_resume(db, uid, rid, q, top_k=3)
            print(f"\n[4] search_resume('{q}') → {len(res)}건")
            for c in res:
                print(f"    [{c['chunk_type']} sim={c['similarity']}] {c['content'][:80]}")

    print("\nALL DONE")


if __name__ == "__main__":
    asyncio.run(main())
