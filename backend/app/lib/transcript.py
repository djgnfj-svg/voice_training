from __future__ import annotations

import re

# Korean filler words — using whitespace/punctuation/start/end as boundaries
FILLER_WORDS_PATTERN = re.compile(
    r"(?:^|[\s,.])(음|어|그|아|뭐|이제|그러니까|그래서|약간|좀|저기|뭐랄까|그니까|어쨌든|일단|뭐냐면|막|진짜|되게|아마)(?=$|[\s,.])"
)


def count_filler_words(text: str) -> int:
    matches = FILLER_WORDS_PATTERN.findall(text)
    return len(matches)
