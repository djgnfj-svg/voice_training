// 한국어 필러워드 — word boundary 대신 공백/문장부호/시작/끝을 경계로 사용
export const FILLER_WORDS = /(?:^|[\s,.])(음|어|그|아|뭐|이제|그러니까|그래서|약간|좀|저기|뭐랄까|그니까|어쨌든|일단|뭐냐면|막|진짜|되게|아마)(?=$|[\s,.])/g;

export function countFillerWords(text: string): number {
  const matches = text.match(FILLER_WORDS);
  return matches ? matches.length : 0;
}

const STUTTER_PATTERN = /(\S+)\s+\1(?=\s|$)/g;

// 부분 반복 패턴: "리액 리액트" → "리액트", "데이터베 데이터베이스" → "데이터베이스"
// 한글 2자 이상의 부분 반복만 매칭 (일반 텍스트 오탐 방지)
const PARTIAL_STUTTER_PATTERN = /([가-힣]{2,})\s+([가-힣]+)/g;

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

  // 필러 워드 제거 (캡처 그룹 앞의 공백/구두점만 유지)
  result = result.replace(FILLER_WORDS, ' ');

  // 반복/더듬기 제거 ("저 저는" → "저는", "그 그래서" → "그래서")
  result = result.replace(STUTTER_PATTERN, '$1');

  // 부분 반복 제거 ("리액 리액트" → "리액트")
  result = removePartialStutter(result);

  // 공백 정규화 + trim
  result = result.replace(/\s+/g, ' ').trim();

  return result;
}
