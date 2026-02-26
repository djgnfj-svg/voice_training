const FILLER_WORDS = /\b(음|어|그|아|뭐|이제|그러니까|그래서|약간|좀|저기|뭐랄까|그니까|어쨌든)\b/g;

const STUTTER_PATTERN = /\b(\S+)\s+\1\b/g;

export function normalizeTranscript(text: string): string {
  let result = text;

  // 필러 워드 제거
  result = result.replace(FILLER_WORDS, '');

  // 반복/더듬기 제거 ("저 저는" → "저는", "그 그래서" → "그래서")
  result = result.replace(STUTTER_PATTERN, '$1');

  // 공백 정규화 + trim
  result = result.replace(/\s+/g, ' ').trim();

  return result;
}
