'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { getLearningStatus } from '@/lib/learning-agent-api';
import { MicCheckDialog } from '@/components/interview/mic-check-dialog';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Moon, Clock, Loader2 } from 'lucide-react';

export default function NightlyStudyPage() {
  const router = useRouter();
  const [showMicCheck, setShowMicCheck] = useState(false);

  const { data: statusData, isLoading } = useQuery({
    queryKey: ['learning-status'],
    queryFn: getLearningStatus,
  });

  const dailyLimitReached = statusData?.dailyLimitReached ?? false;

  const handleMicConfirm = () => {
    setShowMicCheck(false);
    router.push('/nightly-study/session');
  };

  if (isLoading) {
    return (
      <div className="flex h-[60vh] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-lg space-y-6 p-6">
      <div className="text-center">
        <Moon className="mx-auto h-12 w-12 text-primary" />
        <h1 className="mt-4 text-2xl font-bold">오늘의 학습</h1>
        <p className="mt-2 text-muted-foreground">
          AI 튜터와 대화하며 기술 개념을 복습하세요
        </p>
      </div>

      {dailyLimitReached ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-4 py-12">
            <Clock className="h-10 w-10 text-muted-foreground" />
            <div className="text-center">
              <p className="text-lg font-semibold">오늘은 이미 학습했어요!</p>
              <p className="mt-1 text-sm text-muted-foreground">
                내일 다시 만나요. 매일 꾸준히 하는 게 가장 중요해요.
              </p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="flex flex-col items-center gap-4 py-8">
            <div className="text-center space-y-2">
              <p className="text-sm text-muted-foreground">
                AI 튜터가 맞춤형 질문을 통해 학습을 도와줍니다
              </p>
              <Badge variant="secondary">첫 세션 무료</Badge>
            </div>
            <Button
              size="lg"
              className="w-full max-w-xs"
              onClick={() => setShowMicCheck(true)}
            >
              <Moon className="mr-2 h-5 w-5" />
              학습 시작
            </Button>
          </CardContent>
        </Card>
      )}

      <MicCheckDialog
        open={showMicCheck}
        onOpenChange={setShowMicCheck}
        onConfirm={handleMicConfirm}
        loading={false}
      />
    </div>
  );
}
