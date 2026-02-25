'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Loader2, History, Mic } from 'lucide-react';
import { formatDate } from '@/lib/utils';

interface SessionHistory {
  id: string;
  type: string;
  categories: string[];
  difficulty: string;
  status: string;
  overallScore: number | null;
  matchingScore: number | null;
  createdAt: string;
  durationSeconds: number | null;
  jobPosting: { parsedData: any } | null;
  _count: { answers: number };
}

export default function HistoryPage() {
  const { data: sessions, isLoading } = useQuery<SessionHistory[]>({
    queryKey: ['history'],
    queryFn: async () => {
      const res = await fetch('/api/history');
      if (!res.ok) throw new Error('Failed to load history');
      return res.json();
    },
  });

  const typeLabels: Record<string, string> = {
    TECHNICAL: '기술면접',
    BEHAVIORAL: '인성면접',
    MIXED: '혼합면접',
  };

  const statusLabels: Record<string, string> = {
    IN_PROGRESS: '진행 중',
    COMPLETED: '완료',
    ABANDONED: '중단',
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">면접 기록</h1>
          <p className="text-muted-foreground">과거 면접 세션과 결과를 확인하세요</p>
        </div>
        <Link href="/interview/setup">
          <Button>
            <Mic className="mr-2 h-4 w-4" />
            새 면접 시작
          </Button>
        </Link>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : sessions && sessions.length > 0 ? (
        <div className="space-y-3">
          {sessions.map((session) => (
            <Link key={session.id} href={
              session.status === 'COMPLETED'
                ? `/interview/report/${session.id}`
                : `/interview/session/${session.id}`
            }>
              <Card className="transition-colors hover:bg-accent/50">
                <CardContent className="flex items-center justify-between py-4">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{typeLabels[session.type] || session.type}</span>
                      <Badge variant={session.status === 'COMPLETED' ? 'default' : 'secondary'}>
                        {statusLabels[session.status] || session.status}
                      </Badge>
                    </div>
                    <p className="text-sm text-muted-foreground">
                      {session.categories.join(', ')} | {session._count.answers}문제 | {formatDate(session.createdAt)}
                    </p>
                    {session.jobPosting?.parsedData && (
                      <p className="text-xs text-muted-foreground">
                        {(session.jobPosting.parsedData as any).company} - {(session.jobPosting.parsedData as any).position}
                      </p>
                    )}
                  </div>
                  <div className="text-right">
                    {session.overallScore !== null ? (
                      <div>
                        <p className="text-2xl font-bold">{Math.round(session.overallScore)}점</p>
                        {session.matchingScore !== null && (
                          <p className="text-xs text-muted-foreground">매칭도 {session.matchingScore}%</p>
                        )}
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground">-</p>
                    )}
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      ) : (
        <Card>
          <CardContent className="py-12 text-center">
            <History className="mx-auto mb-4 h-10 w-10 text-muted-foreground" />
            <p className="text-muted-foreground">아직 면접 기록이 없습니다</p>
            <Link href="/interview/setup">
              <Button className="mt-4">첫 면접 시작하기</Button>
            </Link>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
