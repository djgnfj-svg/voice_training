import { Flame } from 'lucide-react';

interface Props {
  current: number;
  totalNodesLearned: number;
}

export function StreakBadge({ current, totalNodesLearned }: Props) {
  return (
    <div className="flex items-center justify-center gap-4 text-sm">
      <span className="flex items-center gap-1">
        <Flame className="h-4 w-4 text-orange-500" />
        <span className="font-semibold">{current}일 연속</span>
      </span>
      <span className="text-muted-foreground">|</span>
      <span className="text-muted-foreground">총 {totalNodesLearned}개 학습</span>
    </div>
  );
}
