// 공통 스코어 색상 임계값. 면접 리포트/세션/실시간 피드백에서 재사용.
// 임계: 80 / 60 / 40 — green / blue / amber / red
export function scoreTier(score: number): 'excellent' | 'good' | 'fair' | 'poor' {
  if (score >= 80) return 'excellent';
  if (score >= 60) return 'good';
  if (score >= 40) return 'fair';
  return 'poor';
}

const BG: Record<ReturnType<typeof scoreTier>, string> = {
  excellent: 'bg-green-100 dark:bg-green-900/30',
  good: 'bg-blue-100 dark:bg-blue-900/30',
  fair: 'bg-amber-100 dark:bg-amber-900/30',
  poor: 'bg-red-100 dark:bg-red-900/30',
};

const TEXT: Record<ReturnType<typeof scoreTier>, string> = {
  excellent: 'text-green-600 dark:text-green-400',
  good: 'text-blue-600 dark:text-blue-400',
  fair: 'text-amber-600 dark:text-amber-400',
  poor: 'text-red-600 dark:text-red-400',
};

export function scoreBg(score: number): string {
  return BG[scoreTier(score)];
}

export function scoreText(score: number): string {
  return TEXT[scoreTier(score)];
}
