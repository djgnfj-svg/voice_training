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

    @property
    def is_dev(self) -> bool:
        return self.ENVIRONMENT == "development"

    @property
    def admin_email_list(self) -> list[str]:
        if not self.ADMIN_EMAILS:
            return []
        return [email.strip().lower() for email in self.ADMIN_EMAILS.split(",") if email.strip()]

    model_config = {
        "env_file": ".env",
        "extra": "ignore",
    }


settings = Settings()
