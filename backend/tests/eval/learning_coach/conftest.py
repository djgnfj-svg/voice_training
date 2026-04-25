"""Eval pytest fixtures + case discovery."""
from pathlib import Path

import pytest

from tests.eval.learning_coach.schema import Case, load_all_cases

CASES_DIR = Path(__file__).parent / "cases"


def all_cases() -> list[Case]:
    return load_all_cases(CASES_DIR)
