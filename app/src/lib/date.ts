/** KST 기준 오늘 자정(00:00)을 UTC Date로 반환 */
export function getKstMidnight(): Date {
  const now = new Date();
  const kstOffset = 9 * 60 * 60 * 1000;
  const kstNow = new Date(now.getTime() + kstOffset);
  const kstMidnight = new Date(
    Date.UTC(kstNow.getUTCFullYear(), kstNow.getUTCMonth(), kstNow.getUTCDate())
  );
  return new Date(kstMidnight.getTime() - kstOffset);
}
