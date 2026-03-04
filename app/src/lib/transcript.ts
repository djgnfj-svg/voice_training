const FILLER_WORDS = /\b(음|어|그|아|뭐|이제|그러니까|그래서|약간|좀|저기|뭐랄까|그니까|어쨌든|일단|뭐냐면|막|진짜|되게|아마)\b/g;

const STUTTER_PATTERN = /\b(\S+)\s+\1\b/g;

// 부분 반복 패턴: "리액 리액트" → "리액트", "데이터베 데이터베이스" → "데이터베이스"
const PARTIAL_STUTTER_PATTERN = /\b(\S{2,})\s+(\S+)\b/g;

function removePartialStutter(text: string): string {
  return text.replace(PARTIAL_STUTTER_PATTERN, (_match, partial, full) => {
    if (full.startsWith(partial) && full.length > partial.length) {
      return full;
    }
    return `${partial} ${full}`;
  });
}

export function normalizeTranscript(text: string): string {
  let result = text;

  // 필러 워드 제거
  result = result.replace(FILLER_WORDS, '');

  // 반복/더듬기 제거 ("저 저는" → "저는", "그 그래서" → "그래서")
  result = result.replace(STUTTER_PATTERN, '$1');

  // 부분 반복 제거 ("리액 리액트" → "리액트")
  result = removePartialStutter(result);

  // 공백 정규화 + trim
  result = result.replace(/\s+/g, ' ').trim();

  return result;
}
