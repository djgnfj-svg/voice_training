"""Eval case schema — dataclasses and YAML loader."""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

import yaml


@dataclass
class Message:
    role: Literal["user", "assistant"]
    content: str


@dataclass
class Fixture:
    goal: str
    subject: str
    current_topic: str
    proficiency: int
    recent_messages: list[Message]
    user_message: str


@dataclass
class Rules:
    must_not_contain: list[str] = field(default_factory=list)
    must_address_any: list[str] = field(default_factory=list)
    must_have_question: bool = False
    max_chars: int | None = None


@dataclass
class Judge:
    criteria: str
    pass_threshold: int = 3


@dataclass
class Case:
    id: str
    description: str
    fixture: Fixture
    rules: Rules
    judge: Judge


def load_case(path: Path) -> Case:
    raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    fx = raw["fixture"]
    fixture = Fixture(
        goal=fx["goal"],
        subject=fx["subject"],
        current_topic=fx["current_topic"],
        proficiency=int(fx["proficiency"]),
        recent_messages=[Message(**m) for m in fx.get("recent_messages", [])],
        user_message=fx["user_message"],
    )
    r = raw.get("rules") or {}
    rules = Rules(
        must_not_contain=list(r.get("must_not_contain", [])),
        must_address_any=list(r.get("must_address_any", [])),
        must_have_question=bool(r.get("must_have_question", False)),
        max_chars=r.get("max_chars"),
    )
    j = raw["judge"]
    judge = Judge(criteria=j["criteria"], pass_threshold=int(j.get("pass_threshold", 3)))
    return Case(id=raw["id"], description=raw["description"], fixture=fixture, rules=rules, judge=judge)


def load_all_cases(dir_path: Path) -> list[Case]:
    return [load_case(p) for p in sorted(dir_path.glob("*.yaml"))]
