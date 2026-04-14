"""기존 in_progress 상태의 agent_interview_sessions를 강제 마감.

새 Scan+Dive 구조와 phase/scan_plan/dive_plan 컬럼이 NULL인 세션은 호환 안 됨.
abandoned 처리.
"""
import asyncio
import os

import asyncpg


async def main() -> None:
    url = os.environ["DATABASE_URL"]
    url = url.replace("postgresql+asyncpg://", "postgresql://").replace("postgresql+psycopg://", "postgresql://")
    conn = await asyncpg.connect(url, statement_cache_size=0)

    count = await conn.fetchval(
        "SELECT COUNT(*) FROM agent_interview_sessions WHERE status = 'in_progress' AND phase IS NULL"
    )
    print(f"레거시 in_progress 세션 (phase=NULL): {count}")

    if count:
        await conn.execute("""
            UPDATE agent_interview_sessions
            SET status = 'abandoned', "updatedAt" = NOW()
            WHERE status = 'in_progress' AND phase IS NULL
        """)
        print("마감 완료")
    await conn.close()


if __name__ == "__main__":
    asyncio.run(main())
