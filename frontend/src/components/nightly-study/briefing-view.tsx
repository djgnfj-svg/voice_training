'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Flame, Sparkles, TrendingUp } from 'lucide-react';
import type { EndResponse } from '@/lib/nightly-study-api';

interface Props {
  result: EndResponse;
  onClose: () => void;
}

export function BriefingView({ result, onClose }: Props) {
  const learned = result.highlights?.learned ?? [];
  const improved = result.highlights?.improved ?? [];
  const headline = result.highlights?.headline ?? '오늘도 수고하셨어요';
  const streak = result.streakUpdated ?? { current: 0, longest: 0, totalSessions: 0, totalNodesLearned: 0, isNewRecord: false };

  return (
    <div className="mx-auto max-w-2xl space-y-5 p-4 pb-8 md:p-8">
      <div className="space-y-1 text-center">
        <p className="text-xs uppercase tracking-wider text-muted-foreground">오늘의 브리핑</p>
        <h2 className="text-2xl font-bold">수고하셨어요</h2>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Sparkles className="h-4 w-4 text-primary" /> 오늘의 하이라이트
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-base leading-relaxed">{headline}</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <TrendingUp className="h-4 w-4 text-primary" /> 새로 이해한 것
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {learned.length === 0 ? (
            <p className="text-sm text-muted-foreground">—</p>
          ) : (
            <ul className="space-y-1.5 text-sm leading-relaxed">
              {learned.map((item, i) => (
                <li key={i} className="flex gap-2">
                  <span className="text-primary">•</span>
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          )}
          {improved.length > 0 && (
            <div className="mt-3 border-t pt-3">
              <p className="mb-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                개선 포인트
              </p>
              <ul className="space-y-1.5 text-sm leading-relaxed">
                {improved.map((item, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="text-amber-600">•</span>
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex items-center justify-between py-5">
          <div className="flex items-center gap-2.5">
            <Flame className="h-6 w-6 text-orange-500" />
            <span className="text-lg font-bold">{streak.current}일</span>
            {streak.isNewRecord && (
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">
                최고 기록
              </span>
            )}
          </div>
          <div className="text-right text-xs text-muted-foreground">
            <div>총 {streak.totalSessions}회 학습</div>
            <div>{streak.totalNodesLearned}개 토픽 마스터</div>
          </div>
        </CardContent>
      </Card>

      <Button onClick={onClose} size="lg" className="h-12 w-full">
        확인
      </Button>
    </div>
  );
}
