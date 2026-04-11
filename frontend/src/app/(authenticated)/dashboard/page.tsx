'use client';

import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Mic, BookOpen, Moon, Loader2, ArrowRight } from 'lucide-react';
import { WelcomeDialog } from '@/components/onboarding/welcome-dialog';
import { formatDate } from '@/lib/utils';

interface ActivityItem {
  kind: 'interview' | 'journal' | 'learning';
  id: string;
  title: string;
  subtitle: string;
  status: string;
  createdAt: string;
}

interface DashboardData {
  userName: string | null;
  freeTrialUsed: boolean;
  stats: {
    interviewCount: number;
    journalCount: number;
    learningCount: number;
  };
  recentActivity: ActivityItem[];
}

const kindConfig = {
  interview: { icon: Mic, label: '면접', color: 'text-blue-500', bg: 'bg-blue-100 dark:bg-blue-900/30', href: '/interview/setup' },
  journal: { icon: BookOpen, label: '저널', color: 'text-emerald-500', bg: 'bg-emerald-100 dark:bg-emerald-900/30', href: '/journal' },
  learning: { icon: Moon, label: '학습', color: 'text-violet-500', bg: 'bg-violet-100 dark:bg-violet-900/30', href: '/nightly-study' },
};

export default function DashboardPage() {
  const [welcomeDismissed, setWelcomeDismissed] = useState(true);

  const { data, isLoading } = useQuery<DashboardData>({
    queryKey: ['dashboard'],
    queryFn: async () => {
      const res = await fetch('/api/dashboard');
      if (!res.ok) throw new Error('Failed to fetch');
      return res.json();
    },
  });

  useEffect(() => {
    if (!data) return;
    const key = `welcome_dismissed_${data.userName ?? 'default'}`;
    if (localStorage.getItem(key)) {
      setWelcomeDismissed(true);
    } else if (!data.freeTrialUsed && data.stats.interviewCount === 0) {
      setWelcomeDismissed(false);
    }
  }, [data]);

  const handleWelcomeClose = () => {
    if (data) {
      const key = `welcome_dismissed_${data.userName ?? 'default'}`;
      localStorage.setItem(key, '1');
    }
    setWelcomeDismissed(true);
  };

  if (isLoading || !data) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const totalActivity = data.stats.interviewCount + data.stats.journalCount + data.stats.learningCount;

  return (
    <div className="space-y-6">
      {!welcomeDismissed && (
        <WelcomeDialog
          open={true}
          onOpenChange={(open) => { if (!open) handleWelcomeClose(); }}
        />
      )}

      <div>
        <h1 className="text-2xl font-bold md:text-3xl">안녕하세요, {data.userName}님!</h1>
        <p className="text-muted-foreground">오늘도 함께 준비해볼까요?</p>
      </div>

      {/* Quick Start Cards */}
      <div className="grid gap-4 sm:grid-cols-3">
        <Link href="/interview/setup">
          <Card className="transition-all hover:shadow-md hover:border-blue-300 dark:hover:border-blue-700">
            <CardContent className="flex items-center gap-4 py-5">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-blue-100 dark:bg-blue-900/30">
                <Mic className="h-6 w-6 text-blue-500" />
              </div>
              <div className="min-w-0">
                <p className="font-semibold">면접 연습</p>
                <p className="text-sm text-muted-foreground">{data.stats.interviewCount}회 완료</p>
              </div>
            </CardContent>
          </Card>
        </Link>

        <Link href="/journal">
          <Card className="transition-all hover:shadow-md hover:border-emerald-300 dark:hover:border-emerald-700">
            <CardContent className="flex items-center gap-4 py-5">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-emerald-100 dark:bg-emerald-900/30">
                <BookOpen className="h-6 w-6 text-emerald-500" />
              </div>
              <div className="min-w-0">
                <p className="font-semibold">하루의 정리</p>
                <p className="text-sm text-muted-foreground">{data.stats.journalCount}회 기록</p>
              </div>
            </CardContent>
          </Card>
        </Link>

        <Link href="/nightly-study">
          <Card className="transition-all hover:shadow-md hover:border-violet-300 dark:hover:border-violet-700">
            <CardContent className="flex items-center gap-4 py-5">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-violet-100 dark:bg-violet-900/30">
                <Moon className="h-6 w-6 text-violet-500" />
              </div>
              <div className="min-w-0">
                <p className="font-semibold">오늘의 학습</p>
                <p className="text-sm text-muted-foreground">{data.stats.learningCount}회 학습</p>
              </div>
            </CardContent>
          </Card>
        </Link>
      </div>

      {/* Recent Activity */}
      {totalActivity === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <div className="mx-auto mb-6 flex h-20 w-20 items-center justify-center rounded-full bg-primary/10">
              <Mic className="h-10 w-10 text-primary animate-pulse" />
            </div>
            <p className="text-lg font-medium">첫 음성 면접을 시작해보세요</p>
            <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
              이력서를 업로드하면 AI가 맞춤 질문을 생성하고, 음성으로 답변하며 실전 감각을 키울 수 있습니다.
            </p>
            <Link href="/interview/setup">
              <Button className="mt-6" size="lg">
                시작하기
                <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </Link>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          <h2 className="text-lg font-semibold">최근 활동</h2>
          {data.recentActivity.map((item) => {
            const config = kindConfig[item.kind];
            const Icon = config.icon;
            return (
              <Card key={`${item.kind}-${item.id}`} className="transition-colors hover:bg-accent/50">
                <CardContent className="flex items-center gap-4 py-4">
                  <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${config.bg}`}>
                    <Icon className={`h-5 w-5 ${config.color}`} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{item.title}</span>
                      <Badge variant="outline" className="text-xs">{config.label}</Badge>
                    </div>
                    <p className="truncate text-sm text-muted-foreground">
                      {item.subtitle}{item.subtitle && ' · '}{formatDate(item.createdAt)}
                    </p>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
