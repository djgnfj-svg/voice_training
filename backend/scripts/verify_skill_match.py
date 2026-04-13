"""compute_skill_match 단위 검증.

실행: docker exec voice_training-backend-1 python -m scripts.verify_skill_match
"""
from app.agent.fit_analyzer import compute_skill_match, _normalize_skill, _extract_jd_skills


def test_normalize():
    assert _normalize_skill("Next.js") == "nextjs"
    assert _normalize_skill("NextJS") == "nextjs"
    assert _normalize_skill("next js") == "nextjs"
    assert _normalize_skill("react-native") == "reactnative"
    assert _normalize_skill("") == ""
    print("test_normalize PASS")


def test_match_basic():
    m = compute_skill_match(["React", "TypeScript", "Node.js"], ["react", "GraphQL", "Node JS"])
    assert "react" in m["matched"], m
    assert "Node JS" in m["matched"], m
    assert "GraphQL" in m["gap"], m
    assert m["coverage"] == round(2/3, 3), m
    print("test_match_basic PASS")


def test_no_jd():
    assert compute_skill_match(["React"], []) is None
    print("test_no_jd PASS")


def test_full_match():
    m = compute_skill_match(["React"], ["React"])
    assert m["coverage"] == 1.0
    assert m["gap"] == []
    print("test_full_match PASS")


def test_full_gap():
    m = compute_skill_match([], ["React"])
    assert m["coverage"] == 0.0
    assert m["matched"] == []
    print("test_full_gap PASS")


def test_extract_jd_skills():
    assert _extract_jd_skills({"requiredSkills": ["A"]}) == ["A"]
    assert _extract_jd_skills({"techStack": ["B"]}) == ["B"]
    assert _extract_jd_skills(None) == []
    assert _extract_jd_skills({}) == []
    print("test_extract_jd_skills PASS")


if __name__ == "__main__":
    test_normalize()
    test_match_basic()
    test_no_jd()
    test_full_match()
    test_full_gap()
    test_extract_jd_skills()
    print("\nALL PASS")
