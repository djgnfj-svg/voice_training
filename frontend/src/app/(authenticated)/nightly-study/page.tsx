'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { GraduationCap, Loader2 } from 'lucide-react';
import {
  getStatus,
  startSession,
  endSession,
  type StartResponse,
  type EndResponse,
} from '@/lib/nightly-study-api';
import { StreakBadge } from '@/components/nightly-study/streak-badge';
import { SessionView } from '@/components/nightly-study/session-view';
import { BriefingView } from '@/components/nightly-study/briefing-view';
import { InsufficientCreditsDialog } from '@/components/credit/insufficient-credits-dialog';

type View =
  | { kind: 'landing' }
  | { kind: 'session'; session: StartResponse }
  | { kind: 'briefing'; result: EndResponse };

export default function NightlyStudyPage() {
  const [view, setView] = useState<View>({ kind: 'landing' });
  const [showCreditDialog, setShowCreditDialog] = useState(false);
  const qc = useQueryClient();

  const { data: status, isLoading } = useQuery({
    queryKey: ['ns-status'],
    queryFn: getStatus,
    enabled: view.kind === 'landing',
  });

  const startMut = useMutation({
    mutationFn: startSession,
    onSuccess: (s) => setView({ kind: 'session', session: s }),
    onError: (e: Error) => {
      if (e.message.includes('크레딧') || e.message.includes('INSUFFICIENT_CREDITS')) {
        setShowCreditDialog(true);
      }
    },
  });

  const endMut = useMutation({
    mutationFn: (sessionId: string) => endSession(sessionId),
    onSuccess: (result) => {
      setView({ kind: 'briefing', result });
      qc.invalidateQueries({ queryKey: ['ns-status'] });
    },
  });

  if (view.kind === 'session') {
    return (
      <SessionView
        sessionId={view.session.sessionId}
        firstMessage={view.session.firstMessage}
        currentTopic={view.session.targetNode?.title ?? null}
        onEnd={async () => {
          await endMut.mutateAsync(view.session.sessionId);
        }}
      />
    );
  }

  if (view.kind === 'briefing') {
    return (
      <BriefingView
        result={view.result}
        onClose={() => setView({ kind: 'landing' })}
      />
    );
  }

  // Landing
  return (
    <div className="mx-auto max-w-md space-y-6 p-4 pt-6">
      <div className="text-center">
        <GraduationCap className="mx-auto h-10 w-10 text-primary" />
        <h1 className="mt-3 text-xl font-bold">CS 학습 어시스트</h1>
      </div>

      {isLoading || !status ? (
        <div className="flex justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      ) : (
        <>
          <StreakBadge
            current={status.streak.current}
            totalNodesLearned={status.streak.totalNodesLearned}
          />

          <Card>
            <CardContent className="flex flex-col items-center gap-3 py-8">
              {status.hasGoal && status.todayTargetNode ? (
                <p className="text-sm text-muted-foreground">
                  오늘은 <span className="font-semibold">{status.todayTargetNode.title}</span>
                </p>
              ) : !status.hasGoal ? (
                <p className="text-sm text-muted-foreground text-center">
                  처음이시네요. 시작하면 목표를 물어볼게요.
                </p>
              ) : null}

              {!status.dailyFreeUsed ? (
                <Badge variant="secondary">오늘 무료</Badge>
              ) : (
                <Badge variant="outline">추가 1코인 · 잔액 {status.creditBalance}</Badge>
              )}

              <Button
                size="lg"
                className="w-full h-14"
                onClick={() => startMut.mutate()}
                disabled={startMut.isPending}
              >
                {startMut.isPending ? (
                  <Loader2 className="h-5 w-5 animate-spin" />
                ) : (
                  <>● 시작</>
                )}
              </Button>
            </CardContent>
          </Card>

          {status.recentSessions.length > 0 && (
            <div className="space-y-2">
              <h2 className="text-sm font-semibold text-muted-foreground">지난 세션</h2>
              {status.recentSessions.map((s) => (
                <Card key={s.id}>
                  <CardContent className="py-3">
                    <p className="text-sm">{s.headline}</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      {s.startedAt ? new Date(s.startedAt).toLocaleDateString('ko-KR') : ''}
                    </p>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </>
      )}
      <InsufficientCreditsDialog open={showCreditDialog} onOpenChange={setShowCreditDialog} />
    </div>
  );
}
