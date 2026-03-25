from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.database import engine


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    yield
    # Shutdown
    await engine.dispose()


app = FastAPI(
    title="VoicePrep API",
    version="0.1.0",
    lifespan=lifespan,
)

# Routers
from app.routers.health import router as health_router
from app.routers.user import router as user_router
from app.routers.credits import router as credits_router
from app.routers.resume import router as resume_router
from app.routers.dashboard import router as dashboard_router
from app.routers.coupons import router as coupons_router
from app.routers.payments import router as payments_router
from app.routers.interview_audio import router as interview_audio_router
from app.routers.job_posting import router as job_posting_router
from app.routers.interview import router as interview_router
from app.routers.model_answer import router as model_answer_router
from app.routers.speech import router as speech_router
from app.routers.answer_assist import router as answer_assist_router
from app.routers.admin import router as admin_router
from app.routers.nightly_study import router as nightly_study_router

app.include_router(health_router)
app.include_router(user_router)
app.include_router(credits_router)
app.include_router(resume_router)
app.include_router(dashboard_router)
app.include_router(coupons_router)
app.include_router(payments_router)
app.include_router(interview_audio_router)
app.include_router(job_posting_router)
app.include_router(interview_router)
app.include_router(model_answer_router)
app.include_router(speech_router)
app.include_router(answer_assist_router)
app.include_router(admin_router)
app.include_router(nightly_study_router)
