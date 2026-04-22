"""기존 이력서 전량 백필 임베딩.

실행: docker exec voice_training-backend-1 python -m db.backfill_resume_embeddings
- 이력서 1건당 ~1초 소요 (배치 임베딩 + INSERT)
- 이미 임베딩 있는 이력서는 skip (--force 시 재생성)
"""
from __future__ import annotations

import asyncio
import sys

from sqlalchemy import text

from app.agent.interview.resume_rag import embed_resume
from app.database import async_session


async def main(force: bool = False) -> None:
    async with async_session() as db:
        r = await db.execute(text('SELECT id, "userId", "parsedData" FROM resumes ORDER BY "createdAt"'))
        rows = r.fetchall()

    print(f"Total resumes: {len(rows)}")
    done = 0
    skipped = 0
    failed = 0

    for row in rows:
        rid = row.id
        uid = row.userId
        pd = row.parsedData

        if not force:
            async with async_session() as db:
                exists = (await db.execute(
                    text('SELECT 1 FROM resume_embeddings WHERE "resumeId" = :rid LIMIT 1'),
                    {"rid": rid},
                )).fetchone()
            if exists:
                skipped += 1
                continue

        n = await embed_resume(rid, uid, pd)
        if n > 0:
            done += 1
            print(f"  [{done}] resume {rid[:8]} → {n} chunks")
        else:
            failed += 1
            print(f"  FAILED: resume {rid[:8]}")

    print(f"\nDone: {done} embedded / {skipped} skipped / {failed} failed")


if __name__ == "__main__":
    force = "--force" in sys.argv
    asyncio.run(main(force=force))
