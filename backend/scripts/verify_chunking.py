"""chunk_resume 단위 검증.

실행: docker exec voice_training-backend-1 python -m scripts.verify_chunking
"""
from __future__ import annotations

from app.agent.interview.resume_rag import chunk_resume


def test_full_resume():
    data = {
        "name": "홍길동",
        "summary": "백엔드 3년차, FastAPI 전문",
        "skills": ["Python", "FastAPI"],
        "projects": [
            {
                "name": "쇼핑몰",
                "period": "2023.01~2023.06",
                "techStack": ["Next.js", "Stripe"],
                "role": "백엔드",
                "description": "결제 플로우 설계",
                "achievements": ["장애율 80% 감소"],
            }
        ],
        "experience": [
            {
                "company": "네이버",
                "position": "백엔드",
                "period": "2021.03~2024.02",
                "techStack": ["Python"],
                "description": "추천 서비스",
                "achievements": ["처리량 2배"],
            }
        ],
        "education": [{"school": "서울대", "major": "컴공", "degree": "학사", "period": "2017~2021", "gpa": 4.1}],
    }
    chunks = chunk_resume(data)
    types = [c["chunk_type"] for c in chunks]
    assert types == ["summary", "project", "experience", "education"], f"types={types}"
    assert "[프로젝트] 쇼핑몰" in chunks[1]["content"]
    assert "장애율 80% 감소" in chunks[1]["content"]
    assert "[경력] 네이버 백엔드" in chunks[2]["content"]
    assert "GPA 4.1" in chunks[3]["content"]
    assert chunks[1]["metadata"]["name"] == "쇼핑몰"
    print("test_full_resume PASS")


def test_summary_only():
    data = {"summary": "신입 개발자, React 학습 중"}
    chunks = chunk_resume(data)
    assert len(chunks) == 1
    assert chunks[0]["chunk_type"] == "summary"
    assert chunks[0]["content"] == "신입 개발자, React 학습 중"
    print("test_summary_only PASS")


def test_empty():
    assert chunk_resume(None) == []
    assert chunk_resume({}) == []
    assert chunk_resume({"skills": ["A"], "summary": ""}) == []
    print("test_empty PASS")


def test_skills_excluded():
    data = {"skills": ["React", "Vue"], "summary": "프론트엔드"}
    chunks = chunk_resume(data)
    types = [c["chunk_type"] for c in chunks]
    assert "skill" not in types and "skills" not in types
    print("test_skills_excluded PASS")


def test_partial_project():
    data = {"projects": [{"name": "X", "description": ""}, {"description": "Y만 있음"}]}
    chunks = chunk_resume(data)
    assert len(chunks) == 2, f"len={len(chunks)}"
    assert "[프로젝트] X" in chunks[0]["content"]
    assert "Y만 있음" in chunks[1]["content"]
    print("test_partial_project PASS")


if __name__ == "__main__":
    test_full_resume()
    test_summary_only()
    test_empty()
    test_skills_excluded()
    test_partial_project()
    print("\nALL PASS")
