// 한국어 필러워드 — word boundary 대신 공백/문장부호/시작/끝을 경계로 사용
const FILLER_WORDS = /(?:^|[\s,.])(음|어|그|아|뭐|이제|그러니까|그래서|약간|좀|저기|뭐랄까|그니까|어쨌든|일단|뭐냐면|막|진짜|되게|아마)(?=$|[\s,.])/g;

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

// "제일제일제일" → "제일": 한글 2자 단위가 바로 이어 반복 → 1회로
// (완벽하지 않음 — 더 긴 unit은 useSpeechRecognition overlap 단계에서 차단)
function collapseImmediateRepeats(text: string): string {
  // 2자 한글 unit이 2회 이상 붙어있으면 축소
  let result = text.replace(/([가-힣]{2})\1+/g, '$1');
  // 3자 한글 unit도 같은 처리
  result = result.replace(/([가-힣]{3})\1+/g, '$1');
  return result;
}

// N-gram phrase(1~5 단어)가 연속 반복되면 1회로 축소
// "제일 어려웠던 제일 어려웠던" → "제일 어려웠던"
// "이게 왜 이렇게 이게 왜 이렇게 이게 왜 이렇게" → "이게 왜 이렇게"
// 길이가 긴 n-gram부터 적용해야 짧은 n-gram이 긴 반복을 먼저 먹지 않음
// 한글은 \b word boundary가 작동하지 않으므로 사용하지 않음 (백레퍼런스 자체가 정확 매치 보장)
function collapseRepeatedPhrases(text: string): string {
  let result = text;
  for (let n = 5; n >= 1; n--) {
    const pattern = new RegExp(
      `((?:\\S+\\s+){${n - 1}}\\S+)(?:\\s+\\1)+`,
      'g'
    );
    result = result.replace(pattern, '$1');
  }
  return result;
}

export function normalizeTranscript(text: string): string {
  let result = text;

  // 공백 없이 붙은 한글 반복 먼저 분리 ("제일제일제일" → "제일")
  result = collapseImmediateRepeats(result);

  // 필러 워드 제거 (캡처 그룹 앞의 공백/구두점만 유지)
  result = result.replace(FILLER_WORDS, ' ');

  // 단어 연속 반복 제거 ("저 저는" → "저는", "그 그래서" → "그래서")
  result = result.replace(STUTTER_PATTERN, '$1');

  // 부분 반복 제거 ("리액 리액트" → "리액트")
  result = removePartialStutter(result);

  // 다중 단어 phrase 반복 제거 ("제일 어려웠던 제일 어려웠던" → "제일 어려웠던")
  result = collapseRepeatedPhrases(result);

  // 공백 정규화 + trim
  result = result.replace(/\s+/g, ' ').trim();

  return result;
}

// 답변이 실질적 내용을 갖는지 체크 (버그 #2 가드용)
// normalizeTranscript 결과 기준
export function hasMeaningfulContent(normalizedText: string): boolean {
  if (normalizedText.length < 10) return false;
  const tokens = normalizedText.split(/\s+/).filter((t) => t.length > 0);
  const uniqueTokens = new Set(tokens);
  if (uniqueTokens.size < 3) return false;
  return true;
}
