from app.agent.interview.evaluation import _normalize_evaluation


def test_inner_thought_preserved_when_present():
    raw = {
        "scores": {"clarity": 80, "accuracy": 80, "practicality": 80, "depth": 80, "completeness": 80},
        "innerThought": "오 좋은 답변인데?",
    }
    result = _normalize_evaluation(raw, answer="실제 답변 내용입니다 충분히 길어요 키워드 다양성도 OK")
    assert result["innerThought"] == "오 좋은 답변인데?"


def test_inner_thought_trimmed_to_80_chars():
    long_thought = "가" * 200
    raw = {
        "scores": {"clarity": 80, "accuracy": 80, "practicality": 80, "depth": 80, "completeness": 80},
        "innerThought": long_thought,
    }
    result = _normalize_evaluation(raw, answer="답변 내용 충분히 길어요 키워드 다양해요 OK")
    assert len(result["innerThought"]) <= 80


def test_inner_thought_fallback_when_missing_high_score():
    raw = {
        "scores": {"clarity": 90, "accuracy": 90, "practicality": 90, "depth": 90, "completeness": 90},
    }
    result = _normalize_evaluation(raw, answer="좋은 답변 내용 충분히 길어요 키워드 다양해요 OK")
    assert result["innerThought"]
    assert isinstance(result["innerThought"], str)


def test_inner_thought_fallback_when_low_quality():
    raw = {"scores": {"clarity": 0, "accuracy": 0, "practicality": 0, "depth": 0, "completeness": 0}}
    result = _normalize_evaluation(raw, answer="아아아아아아아아아아아아아아아아아아아아아아")
    assert result["innerThought"]


def test_inner_thought_blank_falls_back():
    raw = {
        "scores": {"clarity": 80, "accuracy": 80, "practicality": 80, "depth": 80, "completeness": 80},
        "innerThought": "   ",
    }
    result = _normalize_evaluation(raw, answer="답변 내용 충분 키워드 다양 OK 길이 충분합니다")
    assert result["innerThought"].strip()
