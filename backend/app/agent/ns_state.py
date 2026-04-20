from __future__ import annotations

from typing import TypedDict, Literal, Optional, Any
from uuid import UUID
from datetime import datetime


Mode = Literal["tutoring", "quiz", "socratic", "onboarding"]
Intent = Literal["answer", "question", "pivot", "meta", "change_goal", "confirm"]
Category = Literal["misconception", "explanation", "connection", "question"]


class MasteryInfo(TypedDict):
    proficiency: int
    success_count: int
    failure_count: int
    streak_count: int
    last_mode: Optional[str]


class NodeRef(TypedDict):
    id: str
    title: str
    description: str
    depth_level: int
    keywords: list[str]


class RagHit(TypedDict):
    id: str
    category: str
    content: str
    similarity: float


class ToolCall(TypedDict):
    tool: str
    args: dict[str, Any]


class Evaluation(TypedDict):
    correct: bool
    partial: bool
    proficiency_delta: int
    misconception: Optional[str]
    notes: str


class PlannerOutput(TypedDict, total=False):
    intent: Intent
    pivot_target: Optional[str]
    evaluation: Optional[Evaluation]
    next_mode: Mode
    actions: list[ToolCall]
    should_suggest_end: bool
    briefing_note: Optional[str]
    # Goal-change (session-level) 2-turn protocol fields
    goal_change_proposed: Optional[str]
    goal_change_confirm: Optional[bool]


class TurnState(TypedDict):
    session_id: str
    user_id: str
    user_utterance: str
    current_node: Optional[NodeRef]
    current_mode: Mode
    mastery: Optional[MasteryInfo]
    turn_count: int
    session_started_at: datetime
    assistant_reply: str
    planner_output: Optional[PlannerOutput]
    tool_results: list[dict[str, Any]]
    node_changed_to: Optional[NodeRef]
    proficiency_after: Optional[int]
    should_suggest_end: bool
