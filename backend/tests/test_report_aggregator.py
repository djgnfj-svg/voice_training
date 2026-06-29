"""Tests for aggregate_evaluations."""
from app.agent.interview.report_metrics import aggregate_evaluations


def _turn(q: str, score: int, *, scores: dict | None = None, meta: dict | None = None,
          demo: list[str] | None = None, miss: list[str] | None = None) -> dict:
    return {
        "question": q,
        "answer": "답변",
        "evaluation": {
            "scores": scores or {"clarity": score, "accuracy": score, "practicality": score, "depth": score, "completeness": score},
            "overallScore": score,
            "demonstratedKeywords": demo or [],
            "missingKeywords": miss or [],
            "meta": meta or {"rubricLabel": "FastAPI", "hasEvidence": True, "importance": "must"},
        },
    }


def test_empty_history_returns_safe_defaults():
    out = aggregate_evaluations([])
    assert out["overallStats"]["count"] == 0
    assert out["categoryBreakdown"] == {}
    assert out["coverageAnalysis"] == []
    assert out["keywordStats"] == {"demonstrated": [], "missing": []}
    assert out["extremes"]["best"] is None
    assert out["extremes"]["worst"] is None


def test_category_breakdown_avg_min_max():
    history = [
        _turn("Q1", 80, scores={"clarity": 80, "accuracy": 70, "practicality": 60, "depth": 50, "completeness": 40}),
        _turn("Q2", 60, scores={"clarity": 60, "accuracy": 90, "practicality": 40, "depth": 70, "completeness": 60}),
    ]
    out = aggregate_evaluations(history)
    assert out["categoryBreakdown"]["clarity"] == {"avg": 70, "min": 60, "max": 80}
    assert out["categoryBreakdown"]["accuracy"] == {"avg": 80, "min": 70, "max": 90}


def test_coverage_analysis_groups_by_rubric_label():
    history = [
        _turn("Q1", 80, meta={"rubricLabel": "FastAPI API", "hasEvidence": True, "importance": "must"}),
        _turn("Q2", 60, meta={"rubricLabel": "FastAPI API", "hasEvidence": True, "importance": "must"}),
        _turn("Q3", 40, meta={"rubricLabel": "Kafka 메시징", "hasEvidence": False, "importance": "nice"}),
    ]
    out = aggregate_evaluations(history)
    cov = {c["label"]: c for c in out["coverageAnalysis"]}
    assert cov["FastAPI API"]["avg"] == 70
    assert cov["FastAPI API"]["qIndices"] == [1, 2]
    assert cov["FastAPI API"]["hasEvidence"] is True
    assert cov["Kafka 메시징"]["avg"] == 40
    assert cov["Kafka 메시징"]["hasEvidence"] is False


def test_extremes_best_and_worst():
    history = [
        _turn("왜 React를 썼나요", 80),
        _turn("DB 설계 설명", 40),
        _turn("배포 파이프라인", 90),
    ]
    out = aggregate_evaluations(history)
    assert out["extremes"]["best"]["qIdx"] == 3
    assert out["extremes"]["best"]["score"] == 90
    assert out["extremes"]["worst"]["qIdx"] == 2
    assert out["extremes"]["worst"]["score"] == 40


def test_keyword_stats_count_and_indices():
    history = [
        _turn("Q1", 70, demo=["JWT", "refresh token"], miss=["CSRF"]),
        _turn("Q2", 60, demo=["JWT", "React"], miss=["CSRF", "XSS"]),
        _turn("Q3", 80, demo=["React"], miss=[]),
    ]
    out = aggregate_evaluations(history)
    demo = {k["keyword"]: k for k in out["keywordStats"]["demonstrated"]}
    assert demo["JWT"]["count"] == 2
    assert demo["JWT"]["qIndices"] == [1, 2]
    assert demo["React"]["count"] == 2
    miss = {k["keyword"]: k for k in out["keywordStats"]["missing"]}
    assert miss["CSRF"]["count"] == 2
    assert miss["XSS"]["count"] == 1


def test_keyword_stats_top_10_only():
    history = [_turn("Q1", 70, demo=[f"k{i}" for i in range(15)])]
    out = aggregate_evaluations(history)
    assert len(out["keywordStats"]["demonstrated"]) <= 10


def test_skipped_answers_excluded():
    """'(건너뜀)' 답변이나 evaluation 없는 턴은 제외."""
    history = [
        _turn("Q1", 80),
        {"question": "Q2", "answer": "(건너뜀)", "evaluation": None},
        {"question": "Q3", "answer": "답", "evaluation": {}},
    ]
    out = aggregate_evaluations(history)
    assert out["overallStats"]["count"] == 1


def test_format_aggregate_renders_all_sections():
    """format_aggregate_for_prompt 주요 섹션 헤더와 값이 텍스트에 포함."""
    from app.agent.interview.report_metrics import format_aggregate_for_prompt
    history = [
        _turn("React에서 useMemo를 썼나요?", 80, demo=["useMemo", "의존성 배열"], miss=["useCallback"],
              meta={"rubricLabel": "프론트 렌더 최적화", "hasEvidence": True, "importance": "must"}),
        _turn("상태관리 라이브러리 선택 기준?", 50, demo=["Redux"], miss=["Context API", "Zustand"],
              meta={"rubricLabel": "상태관리 설계", "hasEvidence": False, "importance": "nice"}),
    ]
    agg = aggregate_evaluations(history)
    text = format_aggregate_for_prompt(agg)
    # 전체 헤더
    assert "전체: 2개 답변" in text
    # 역량별
    assert "[역량별 평균/최저/최고]" in text
    # JD 루브릭 커버리지
    assert "[JD 루브릭 커버리지" in text
    assert "프론트 렌더 최적화" in text
    assert "상태관리 설계" in text
    assert "근거 없음(gap)" in text
    # 최고/최저
    assert "[최고/최저 답변]" in text
    # 키워드
    assert "[답변에서 잘 다룬 기술 키워드" in text
    assert "useMemo" in text
    assert "[답변에서 빠진 핵심 기술 키워드" in text
    assert "Context API" in text


def test_format_aggregate_empty_returns_default():
    from app.agent.interview.report_metrics import format_aggregate_for_prompt
    text = format_aggregate_for_prompt(aggregate_evaluations([]))
    # 빈 집계도 전체 라인은 항상 출력 (기존 동작)
    assert "전체: 0개 답변" in text


def test_qidx_uses_question_number_when_present():
    """사용자가 Q2를 스킵한 상황: history엔 2개지만 qIdx는 1,3이어야 함."""
    history = [
        {
            "question": "Q1",
            "answer": "답",
            "question_number": 1,
            "evaluation": {
                "scores": {"clarity": 80, "accuracy": 80, "practicality": 80, "depth": 80, "completeness": 80},
                "overallScore": 80,
                "meta": {"rubricLabel": "A", "hasEvidence": True, "importance": "must"},
            },
        },
        {
            "question": "Q3",
            "answer": "답",
            "question_number": 3,
            "evaluation": {
                "scores": {"clarity": 50, "accuracy": 50, "practicality": 50, "depth": 50, "completeness": 50},
                "overallScore": 50,
                "meta": {"rubricLabel": "B", "hasEvidence": False, "importance": "nice"},
            },
        },
    ]
    agg = aggregate_evaluations(history)
    assert agg["extremes"]["best"]["qIdx"] == 1
    assert agg["extremes"]["worst"]["qIdx"] == 3
    cov = {c["label"]: c for c in agg["coverageAnalysis"]}
    assert cov["A"]["qIndices"] == [1]
    assert cov["B"]["qIndices"] == [3]
