import enum

from sqlalchemy.dialects.postgresql import ENUM


class InterviewType(str, enum.Enum):
    TECHNICAL = "TECHNICAL"
    BEHAVIORAL = "BEHAVIORAL"
    MIXED = "MIXED"


class Difficulty(str, enum.Enum):
    BEGINNER = "BEGINNER"
    INTERMEDIATE = "INTERMEDIATE"
    ADVANCED = "ADVANCED"


class SessionStatus(str, enum.Enum):
    IN_PROGRESS = "IN_PROGRESS"
    COMPLETED = "COMPLETED"
    ABANDONED = "ABANDONED"


class PaymentStatus(str, enum.Enum):
    PENDING = "PENDING"
    DONE = "DONE"
    FAILED = "FAILED"
    CANCELED = "CANCELED"


class ActivityType(str, enum.Enum):
    MODEL_ANSWER = "MODEL_ANSWER"
    NIGHTLY_STUDY = "NIGHTLY_STUDY"
    LEARNING_SESSION = "LEARNING_SESSION"
    LEARNING_AGENT = "LEARNING_AGENT"


class CreditTxType(str, enum.Enum):
    FREE_TRIAL = "FREE_TRIAL"
    ADMIN_GRANT = "ADMIN_GRANT"
    PURCHASE = "PURCHASE"
    SESSION_DEBIT = "SESSION_DEBIT"
    FEATURE_DEBIT = "FEATURE_DEBIT"
    REFUND = "REFUND"
    COUPON = "COUPON"
    LEARNING_DEBIT = "LEARNING_DEBIT"


# SQLAlchemy ENUM types mapped to existing PostgreSQL enums (created by Prisma)
# create_type=False tells SQLAlchemy NOT to CREATE TYPE, just reference it
PgInterviewType = ENUM(InterviewType, name="InterviewType", create_type=False)
PgDifficulty = ENUM(Difficulty, name="Difficulty", create_type=False)
PgSessionStatus = ENUM(SessionStatus, name="SessionStatus", create_type=False)
PgPaymentStatus = ENUM(PaymentStatus, name="PaymentStatus", create_type=False)
PgActivityType = ENUM(ActivityType, name="ActivityType", create_type=False)
PgCreditTxType = ENUM(CreditTxType, name="CreditTxType", create_type=False)
