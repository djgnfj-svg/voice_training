from collections.abc import AsyncGenerator

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from app.config import settings


def _build_database_url(url: str) -> str:
    """Convert postgres:// to postgresql+asyncpg:// for SQLAlchemy async support."""
    # Remove pgbouncer param (asyncpg doesn't understand it)
    url = url.replace("?pgbouncer=true", "").replace("&pgbouncer=true", "")
    if url.startswith("postgres://"):
        return url.replace("postgres://", "postgresql+asyncpg://", 1)
    if url.startswith("postgresql://"):
        return url.replace("postgresql://", "postgresql+asyncpg://", 1)
    return url


engine = create_async_engine(
    _build_database_url(settings.DATABASE_URL),
    pool_size=5,
    max_overflow=10,
    pool_recycle=300,
    # Disable prepared statement cache for pgbouncer compatibility
    connect_args={"prepared_statement_cache_size": 0, "statement_cache_size": 0},
)

async_session = async_sessionmaker(
    engine,
    class_=AsyncSession,
    expire_on_commit=False,
)


class Base(DeclarativeBase):
    pass


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    async with async_session() as session:
        yield session
