from __future__ import annotations

from typing import Optional


def _normalize(s: str) -> str:
    return "".join(ch.lower() for ch in s if not ch.isspace())


def match_pivot_target(
    candidate_nodes: list[dict],
    target: str,
) -> Optional[dict]:
    """
    Match user's pivot target to an existing curriculum node.
    Strategy: normalized title equality → title substring → keyword exact (normalized) → None.
    """
    target_norm = _normalize(target)
    if not target_norm:
        return None

    # 1. normalized title exact / substring
    for node in candidate_nodes:
        if _normalize(node["title"]) == target_norm:
            return node
    for node in candidate_nodes:
        if target_norm in _normalize(node["title"]):
            return node
        if _normalize(node["title"]) in target_norm:
            return node

    # 2. keyword exact match (normalized)
    for node in candidate_nodes:
        for kw in node.get("keywords", []):
            if _normalize(kw) == target_norm:
                return node

    return None
