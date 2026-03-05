'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Loader2, History, Mic, RotateCcw, BookOpen } from 'lucide-react';
import { formatDate } from '@/lib/utils';
import type { ParsedJobPosting } from '@/types';

interface SessionItem {
  _kind: 'session';
  id: string;
  type: string;
  categories: string[];
  difficulty: string;
  status: string;
  overallScore: number | null;
  matchingScore: number | null;
  createdAt: string;
  durationSeconds: number | null;
  jobPosting: { parsedData: ParsedJobPosting } | null;
  _count: { answers: number };
}

interface ActivityItem {
  _kind: 'activity';
  id: string;
  type: 'MODEL_ANSWER';
  resumeId: string | null;
  createdAt: string;
  resume: { name: string } | null;
  _count: { items: number };
}

type HistoryItem = SessionItem | ActivityItem;

export default function HistoryPage() {
  const { data: items, isLoading } = useQuery<HistoryItem[]>({
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
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold md:text-3xl">면접 기록</h1>
          <p className="text-muted-foreground">과거 면접 세션과 평가 결과를 확인하세요</p>
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
      ) : items && items.length > 0 ? (
        <div className="space-y-3">
          {items.map((item) =>
            item._kind === 'session' ? (
              <SessionCard key={`s-${item.id}`} session={item} typeLabels={typeLabels} statusLabels={statusLabels} />
            ) : (
              <ActivityCard key={`a-${item.id}`} activity={item} />
            )
          )}
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

function SessionCard({
  session,
  typeLabels,
  statusLabels,
}: {
  session: SessionItem;
  typeLabels: Record<string, string>;
  statusLabels: Record<string, string>;
}) {
  return (
    <Card className="transition-colors hover:bg-accent/50">
      <Link href={
        session.status === 'COMPLETED'
          ? `/interview/report/${session.id}`
          : `/interview/session/${session.id}`
      }>
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
                {session.jobPosting.parsedData.company} - {session.jobPosting.parsedData.position}
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
      </Link>
      {session.status === 'COMPLETED' && (
        <div className="border-t px-6 py-2">
          <Link href={`/interview/practice/${session.id}`}>
            <Button variant="ghost" size="sm" className="text-xs">
              <RotateCcw className="mr-1 h-3 w-3" />
              연습
            </Button>
          </Link>
        </div>
      )}
    </Card>
  );
}

function ActivityCard({ activity }: { activity: ActivityItem }) {
  return (
    <Card className="transition-colors hover:bg-accent/50">
      <Link href={`/history/activity/${activity.id}`}>
        <CardContent className="flex items-center justify-between py-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <BookOpen className="h-4 w-4 text-emerald-500" />
              <span className="font-medium">모범답안 학습</span>
              <Badge variant="outline">모범답안</Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              {activity.resume?.name && <>{activity.resume.name} | </>}
              {activity._count.items}개 질문 | {formatDate(activity.createdAt)}
            </p>
          </div>
          <div className="text-right">
            <p className="text-sm text-muted-foreground">복습하기</p>
          </div>
        </CardContent>
      </Link>
    </Card>
  );
}
