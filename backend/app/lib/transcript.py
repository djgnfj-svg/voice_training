from __future__ import annotations

import re

# Korean filler words — using whitespace/punctuation/start/end as boundaries
FILLER_WORDS_PATTERN = re.compile(
    r"(?:^|[\s,.])(음|어|그|아|뭐|이제|그러니까|그래서|약간|좀|저기|뭐랄까|그니까|어쨌든|일단|뭐냐면|막|진짜|되게|아마)(?=$|[\s,.])"
)

STUTTER_PATTERN = re.compile(r"(\S+)\s+\1(?=\s|$)")

# Partial repetition: "리액 리액트" → "리액트"
PARTIAL_STUTTER_PATTERN = re.compile(r"([가-힣]{2,})\s+([가-힣]+)")


def count_filler_words(text: str) -> int:
    matches = FILLER_WORDS_PATTERN.findall(text)
    return len(matches)


def _remove_partial_stutter(text: str) -> str:
    def replacer(match: re.Match) -> str:
        partial = match.group(1)
        full = match.group(2)
        if full.startswith(partial) and len(full) > len(partial):
            return full
        return f"{partial} {full}"

    return PARTIAL_STUTTER_PATTERN.sub(replacer, text)


def normalize_transcript(text: str) -> str:
    result = text

    # Remove filler words
    result = FILLER_WORDS_PATTERN.sub(" ", result)

    # Remove stuttering
    result = STUTTER_PATTERN.sub(r"\1", result)

    # Remove partial repetition
    result = _remove_partial_stutter(result)

    # Normalize whitespace
    result = re.sub(r"\s+", " ", result).strip()

    return result
