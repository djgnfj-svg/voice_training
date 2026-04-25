'use client';

import { useRouter } from 'next/navigation';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { GraduationCap, Loader2 } from 'lucide-react';
import {
  getStatus,
  startSession,
  type StartResponse,
} from '@/lib/learning-coach-api';
import { StreakBadge } from '@/components/learning-coach/streak-badge';

const START_CACHE_KEY = (id: string) => `ns:start:${id}`;

export default function LearningCoachLanding() {
  const router = useRouter();

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
        // sessionStorage ?ъ슜 遺덇? ???몄뀡 ?섏씠吏媛 GET?쇰줈 蹂듭썝
      }
      router.push(`/learning-coach/session/${s.sessionId}`);
    },
  });

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-4 md:p-8">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10">
          <GraduationCap className="h-5 w-5 text-primary" />
        </div>
        <div>
          <h1 className="text-xl font-bold leading-tight">CS ?숈뒿 ?댁떆?ㅽ듃</h1>
          <p className="text-xs text-muted-foreground">留먰븯硫?蹂듭뒿?섎뒗 CS ?쒗꽣</p>
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
                    <p className="text-xs uppercase tracking-wider text-muted-foreground">?ㅻ뒛??二쇱젣</p>
                    <p className="text-lg font-semibold">{status.todayTargetNode.title}</p>
                  </>
                ) : !status.hasGoal ? (
                  <p className="text-sm text-muted-foreground">
                    泥섏쓬?댁떆?ㅼ슂. ?쒖옉?섎㈃ 紐⑺몴遺??臾쇱뼱蹂쇨쾶??
                  </p>
                ) : (
                  <p className="text-sm text-muted-foreground">?ㅻ뒛 ?댁뼱???대낵源뚯슂?</p>
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
                  '?쒖옉?섍린'
                )}
              </Button>
            </CardContent>
          </Card>

          {status.recentSessions.length > 0 && (
            <div className="space-y-2">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                吏???몄뀡
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
    </div>
  );
}

