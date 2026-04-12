from __future__ import annotations

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # Required
    DATABASE_URL: str
    NEXTAUTH_SECRET: str
    ANTHROPIC_API_KEY: str

    # Optional
    ENVIRONMENT: str = "development"
    TAVILY_API_KEY: str | None = None
    OPENAI_API_KEY: str | None = None
    ADMIN_EMAILS: str = ""

    # Agent
    AGENT_MODEL: str = "claude-haiku-4-5-20251001"

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
