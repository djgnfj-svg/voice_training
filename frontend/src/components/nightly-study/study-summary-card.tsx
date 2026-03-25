'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { CheckCircle, BookOpen, Heart } from 'lucide-react';
import type { StudySummary } from '@/hooks/useNightlyStudy';
import Link from 'next/link';

interface StudySummaryCardProps {
  summary: StudySummary;
}

export function StudySummaryCard({ summary }: StudySummaryCardProps) {
  return (
    <div className="mx-auto max-w-lg space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Heart className="h-5 w-5 text-pink-500" />
            학습 완료!
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* Strengths */}
          {summary.strengths.length > 0 && (
            <div className="space-y-2">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-green-700 dark:text-green-400">
                <CheckCircle className="h-4 w-4" />
                잘한 점
              </h3>
              <ul className="space-y-1 pl-6 text-sm text-muted-foreground">
                {summary.strengths.map((s, i) => (
                  <li key={i} className="list-disc">{s}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Review topics */}
          {summary.reviewTopics.length > 0 && (
            <div className="space-y-2">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-amber-700 dark:text-amber-400">
                <BookOpen className="h-4 w-4" />
                다음에 한번 더 살펴보면 좋을 것
              </h3>
              <ul className="space-y-1 pl-6 text-sm text-muted-foreground">
                {summary.reviewTopics.map((t, i) => (
                  <li key={i} className="list-disc">{t}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Encouragement */}
          <div className="rounded-lg bg-primary/5 p-4 text-center">
            <p className="text-sm font-medium text-primary">{summary.encouragement}</p>
          </div>
        </CardContent>
      </Card>

      <Button asChild className="w-full" variant="outline">
        <Link href="/dashboard">대시보드로 돌아가기</Link>
      </Button>
    </div>
  );
}
