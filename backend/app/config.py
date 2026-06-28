from __future__ import annotations

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # Required
    DATABASE_URL: str
    NEXTAUTH_SECRET: str
    OPENAI_API_KEY: str

    # Optional
    ENVIRONMENT: str = "development"
    ADMIN_EMAILS: str = ""

    # LLM — `.env`의 AGENT_MODEL로 런타임 교체 가능 (예: gpt-4.1-mini, gpt-4.1-nano)
    AGENT_MODEL: str = "gpt-4o-mini"

    # Realtime voice (Learning Coach) — 기본 비활성. 켜야 WS 엔드포인트가 동작
    REALTIME_VOICE_ENABLED: bool = False
    REALTIME_MODEL: str = "gpt-4o-realtime-preview"
    REALTIME_SESSION_MAX_SEC: int = 600  # 세션 하드 캡 (10분)
    REALTIME_DAILY_MAX_SEC: int = 1800  # 사용자당 일일 상한 (30분, KST)
    REALTIME_IDLE_SEC: int = 30  # 무음 자동 종료 (30초)

    @property
    def admin_email_list(self) -> list[str]:
        if not self.ADMIN_EMAILS:
            return []
        return [
            email.strip().lower()
            for email in self.ADMIN_EMAILS.split(",")
            if email.strip()
        ]

    model_config = {
        "env_file": ".env",
        "extra": "ignore",
    }


settings = Settings()
