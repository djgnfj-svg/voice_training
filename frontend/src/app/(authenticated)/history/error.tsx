'use client';

import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';

export default function HistoryError({
  reset,
}: {
  reset: () => void;
}) {
  return (
    <div className="flex min-h-[40vh] items-center justify-center">
      <div className="mx-auto max-w-md space-y-4 text-center">
        <AlertTriangle className="mx-auto h-12 w-12 text-destructive" />
        <h2 className="text-xl font-semibold">오류가 발생했습니다</h2>
        <p className="text-sm text-muted-foreground">
          페이지를 불러오는 중 문제가 발생했습니다. 다시 시도해주세요.
        </p>
        <Button onClick={reset}>다시 시도</Button>
      </div>
    </div>
  );
}
