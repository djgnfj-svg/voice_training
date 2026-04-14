"""Tests for _normalize_evaluation keyword handling."""
from app.agent.evaluator_agent import _normalize_evaluation


def _base(scores: dict | None = None) -> dict:
    return {
        "scores": scores or {"clarity": 80, "accuracy": 70, "practicality": 60, "depth": 50, "completeness": 40},
        "briefFeedback": "",
        "detailedFeedback": "",
        "modelAnswer": "",
        "demonstratedKeywords": [],
        "missingKeywords": [],
    }


def test_keywords_preserved_for_normal_answer():
    ev = _base()
    ev["demonstratedKeywords"] = ["JWT", "refresh token rotation", "HttpOnly cookie"]
    ev["missingKeywords"] = ["CSRF 방어"]
    out = _normalize_evaluation(ev, "JWT와 refresh token rotation으로 세션을 관리합니다. HttpOnly 쿠키로 XSS 방어하고 토큰 만료 시 재발급합니다.")
    assert out["demonstratedKeywords"] == ["JWT", "refresh token rotation", "HttpOnly cookie"]
    assert out["missingKeywords"] == ["CSRF 방어"]


def test_keywords_cleared_on_quality_cap():
    """저품질 답변(반복/단답)은 키워드를 빈 배열로 강제."""
    ev = _base({"clarity": 90, "accuracy": 90, "practicality": 90, "depth": 90, "completeness": 90})
    ev["demonstratedKeywords"] = ["React", "상태관리"]
    ev["missingKeywords"] = ["useReducer"]
    # 10자 미만 → cap=15
    out = _normalize_evaluation(ev, "몰라요")
    assert out["demonstratedKeywords"] == []
    assert out["missingKeywords"] == []
    # 모든 점수가 15 이하여야 함
    assert max(out["scores"].values()) <= 15


def test_demonstrated_keywords_clamped_to_8():
    ev = _base()
    ev["demonstratedKeywords"] = [f"k{i}" for i in range(15)]
    out = _normalize_evaluation(ev, "이 답변은 구체적 기술 개념과 실제 경험 근거를 담아 충분히 길게 작성한 정상 케이스입니다. 트레이드오프, 성능 최적화, 에러 처리, 재시도 전략, 모니터링 지표까지 전부 언급했습니다.")
    assert len(out["demonstratedKeywords"]) == 8


def test_missing_keywords_clamped_to_5():
    ev = _base()
    ev["missingKeywords"] = [f"m{i}" for i in range(9)]
    out = _normalize_evaluation(ev, "이 답변은 구체적 기술 개념과 실제 경험 근거를 담아 충분히 길게 작성한 정상 케이스입니다. 트레이드오프, 성능 최적화, 에러 처리, 재시도 전략, 모니터링 지표까지 전부 언급했습니다.")
    assert len(out["missingKeywords"]) == 5


def test_keywords_dedup_case_insensitive():
    ev = _base()
    ev["demonstratedKeywords"] = ["JWT", "jwt", "  JWT  ", "React"]
    out = _normalize_evaluation(ev, "이 답변은 구체적 기술 개념과 실제 경험 근거를 담아 충분히 길게 작성한 정상 케이스입니다. 트레이드오프, 성능 최적화, 에러 처리, 재시도 전략, 모니터링 지표까지 전부 언급했습니다.")
    # 소문자 키로 dedupe하되 첫 등장 원형 유지
    assert out["demonstratedKeywords"] == ["JWT", "React"]


def test_missing_missing_keywords_defaults_to_empty_list():
    ev = _base()
    # 필드가 아예 없는 경우
    ev.pop("demonstratedKeywords", None)
    ev.pop("missingKeywords", None)
    out = _normalize_evaluation(ev, "이 답변은 구체적 기술 개념과 실제 경험 근거를 담아 충분히 길게 작성한 정상 케이스입니다. 트레이드오프, 성능 최적화, 에러 처리, 재시도 전략, 모니터링 지표까지 전부 언급했습니다.")
    assert out["demonstratedKeywords"] == []
    assert out["missingKeywords"] == []


def test_blank_and_non_string_filtered():
    ev = _base()
    ev["demonstratedKeywords"] = ["", "  ", None, 123, "React"]
    out = _normalize_evaluation(ev, "이 답변은 구체적 기술 개념과 실제 경험 근거를 담아 충분히 길게 작성한 정상 케이스입니다. 트레이드오프, 성능 최적화, 에러 처리, 재시도 전략, 모니터링 지표까지 전부 언급했습니다.")
    assert out["demonstratedKeywords"] == ["React"]
