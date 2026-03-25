'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { useQuery } from '@tanstack/react-query';
import { isAdmin } from '@/lib/admin';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ResumeSelector } from '@/components/resume/resume-selector';
import { useToast } from '@/hooks/useToast';
import { MessageSquare, ArrowRight, CheckCircle2, Loader2 } from 'lucide-react';

interface SessionSummary {
  id: string;
  resumeName: string;
  createdAt: string;
  totalItems: number;
  completedItems: number;
}

export default function AnswerAssistSetupPage() {
  const router = useRouter();
  const { toast } = useToast();
  const { data: session } = useSession();
  const [selectedResumeId, setSelectedResumeId] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  const { data: sessions } = useQuery<SessionSummary[]>({
    queryKey: ['answer-assist-sessions'],
    queryFn: async () => {
      const res = await fetch('/api/answer-assist/sessions');
      if (!res.ok) throw new Error('세션 목록 로드 실패');
      return res.json();
    },
  });

  useEffect(() => {
    if (!isAdmin(session?.user?.email)) {
      router.push('/dashboard');
    }
  }, [session?.user?.email, router]);

  if (!isAdmin(session?.user?.email)) {
    return null;
  }

  const handleStart = async () => {
    if (!selectedResumeId) {
      toast({ title: '이력서를 선택해주세요', variant: 'destructive' });
      return;
    }

    setIsCreating(true);
    try {
      const res = await fetch('/api/answer-assist/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resumeId: selectedResumeId }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || '세션 생성 실패');
      }

      const data = await res.json();
      router.push(`/admin/answer-assist/${data.id}`);
    } catch (error) {
      toast({
        title: '세션 생성에 실패했습니다',
        description: error instanceof Error ? error.message : '',
        variant: 'destructive',
      });
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold md:text-3xl">답변 어시스트</h1>
        <p className="text-muted-foreground">
          AI 꼬리질문으로 면접 답변을 깊이 파고들어 완성도 높은 답변을 준비합니다
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <MessageSquare className="h-5 w-5" />
            사용 방법
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2 text-sm text-muted-foreground">
            <li>1. 이력서를 선택하세요 (필수)</li>
            <li>2. AI가 이력서 기반 면접 질문 5~7개를 생성합니다</li>
            <li>3. 질문을 선택하고 답변을 작성하면 AI가 꼬리질문으로 답변을 깊이 파고듭니다</li>
            <li>4. 충분히 대화한 후 &quot;완성하기&quot;를 클릭하면 대화를 종합한 최종 답변을 생성합니다</li>
            <li>5. 완성된 답변은 저장되어 나중에 복습할 수 있습니다</li>
          </ul>
        </CardContent>
      </Card>

      <ResumeSelector selectedId={selectedResumeId} onSelect={setSelectedResumeId} />

      <Button
        size="lg"
        className="w-full"
        onClick={handleStart}
        disabled={!selectedResumeId || isCreating}
      >
        {isCreating ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        ) : (
          <MessageSquare className="mr-2 h-4 w-4" />
        )}
        {isCreating ? '질문 생성 중...' : '답변 어시스트 시작'}
        {!isCreating && <ArrowRight className="ml-2 h-4 w-4" />}
      </Button>

      {sessions && sessions.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>이전 세션</CardTitle>
            <CardDescription>이전에 작업한 답변 어시스트 세션 목록</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {sessions.map((s) => (
                <button
                  key={s.id}
                  onClick={() => router.push(`/admin/answer-assist/${s.id}`)}
                  className="flex w-full items-center justify-between rounded-lg border p-3 text-left transition-colors hover:bg-accent"
                >
                  <div>
                    <p className="text-sm font-medium">{s.resumeName}</p>
                    <p className="text-xs text-muted-foreground">
                      {new Date(s.createdAt).toLocaleDateString('ko-KR')}
                    </p>
                  </div>
                  <div className="flex items-center gap-1 text-xs text-muted-foreground">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    {s.completedItems}/{s.totalItems}
                  </div>
                </button>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
