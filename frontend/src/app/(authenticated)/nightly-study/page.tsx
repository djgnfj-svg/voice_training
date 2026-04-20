'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { GraduationCap, Loader2 } from 'lucide-react';
import {
  getStatus,
  startSession,
  type StartResponse,
} from '@/lib/nightly-study-api';
import { StreakBadge } from '@/components/nightly-study/streak-badge';
import { InsufficientCreditsDialog } from '@/components/credit/insufficient-credits-dialog';

const START_CACHE_KEY = (id: string) => `ns:start:${id}`;

export default function NightlyStudyLanding() {
  const router = useRouter();
  const [showCreditDialog, setShowCreditDialog] = useState(false);

  const { data: status, isLoading } = useQuery({
    queryKey: ['ns-status'],
    queryFn: getStatus,
  });

  const startMut = useMutation({
    mutationFn: startSession,
    onSuccess: (s: StartResponse) => {
      try {
        sessionStorage.setItem(START_CACHE_KEY(s.sessionId), JSON.stringify(s));
      } catch {
        // sessionStorage 사용 불가 시 세션 페이지가 GET으로 복원
      }
      router.push(`/nightly-study/session/${s.sessionId}`);
    },
    onError: (e: Error) => {
      if (e.message.includes('크레딧') || e.message.includes('INSUFFICIENT_CREDITS')) {
        setShowCreditDialog(true);
      }
    },
  });

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-4 md:p-8">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10">
          <GraduationCap className="h-5 w-5 text-primary" />
        </div>
        <div>
          <h1 className="text-xl font-bold leading-tight">CS 학습 어시스트</h1>
          <p className="text-xs text-muted-foreground">말하며 복습하는 CS 튜터</p>
        </div>
      </div>

      {isLoading || !status ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      ) : (
        <>
          <StreakBadge
            current={status.streak.current}
            totalNodesLearned={status.streak.totalNodesLearned}
          />

          <Card>
            <CardContent className="space-y-5 py-8">
              <div className="space-y-2 text-center">
                {status.hasGoal && status.todayTargetNode ? (
                  <>
                    <p className="text-xs uppercase tracking-wider text-muted-foreground">오늘의 주제</p>
                    <p className="text-lg font-semibold">{status.todayTargetNode.title}</p>
                  </>
                ) : !status.hasGoal ? (
                  <p className="text-sm text-muted-foreground">
                    처음이시네요. 시작하면 목표부터 물어볼게요.
                  </p>
                ) : (
                  <p className="text-sm text-muted-foreground">오늘 이어서 해볼까요?</p>
                )}
              </div>

              <div className="flex justify-center">
                {!status.dailyFreeUsed ? (
                  <Badge variant="secondary">오늘 무료</Badge>
                ) : (
                  <Badge variant="outline">추가 1코인 · 잔액 {status.creditBalance}</Badge>
                )}
              </div>

              <Button
                size="lg"
                className="h-14 w-full text-base"
                onClick={() => startMut.mutate()}
                disabled={startMut.isPending}
              >
                {startMut.isPending ? (
                  <Loader2 className="h-5 w-5 animate-spin" />
                ) : (
                  '시작하기'
                )}
              </Button>
            </CardContent>
          </Card>

          {status.recentSessions.length > 0 && (
            <div className="space-y-2">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                지난 세션
              </h2>
              <div className="space-y-2">
                {status.recentSessions.map((s) => (
                  <Card key={s.id}>
                    <CardContent className="py-3">
                      <p className="text-sm leading-relaxed">{s.headline}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {s.startedAt ? new Date(s.startedAt).toLocaleDateString('ko-KR') : ''}
                      </p>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </div>
          )}
        </>
      )}
      <InsufficientCreditsDialog open={showCreditDialog} onOpenChange={setShowCreditDialog} />
    </div>
  );
}
