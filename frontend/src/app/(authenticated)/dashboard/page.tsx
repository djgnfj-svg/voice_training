'use client';

import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Mic, History, TrendingUp, FileText, Coins, Loader2, BarChart3, ArrowRight } from 'lucide-react';
import { GrowthChart } from '@/components/analytics/growth-chart';
import { CategoryChart } from '@/components/analytics/category-chart';
import { WelcomeDialog } from '@/components/onboarding/welcome-dialog';
import type { GrowthData, CategoryPerformance } from '@/types';

interface DashboardData {
  sessionCount: number;
  recentSessions: {
    id: string;
    type: string;
    overallScore: number | null;
    createdAt: string;
    categories?: string[] | null;
  }[];
  resumeCount: number;
  creditBalance: number;
  freeTrialUsed: boolean;
  userName: string | null;
  growthData: GrowthData[];
  categoryPerformance: CategoryPerformance[];
}

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
    } else if (data.sessionCount === 0 && !data.freeTrialUsed) {
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

  const shouldShowWelcome = !welcomeDismissed;

  if (isLoading || !data) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const scoredSessions = data.recentSessions.filter((s) => s.overallScore !== null);
  const avgScore =
    scoredSessions.length > 0
      ? Math.round(
          scoredSessions.reduce((sum, s) => sum + (s.overallScore || 0), 0) /
            scoredSessions.length
        )
      : 0;

  return (
    <div className="space-y-6">
      {/* Welcome dialog for first-time users */}
      {shouldShowWelcome && (
        <WelcomeDialog
          open={true}
          onOpenChange={(open) => { if (!open) handleWelcomeClose(); }}
        />
      )}

      <div>
        <h1 className="text-2xl font-bold md:text-3xl">대시보드</h1>
        <p className="text-muted-foreground">안녕하세요, {data.userName}님!</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">총 면접 횟수</CardTitle>
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-100 dark:bg-blue-900/30">
              <History className="h-4 w-4 text-blue-600 dark:text-blue-400" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{data.sessionCount}회</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">최근 평균 점수</CardTitle>
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-green-100 dark:bg-green-900/30">
              <TrendingUp className="h-4 w-4 text-green-600 dark:text-green-400" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{avgScore}점</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">이력서</CardTitle>
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-purple-100 dark:bg-purple-900/30">
              <FileText className="h-4 w-4 text-purple-600 dark:text-purple-400" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{data.resumeCount}개</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">크레딧</CardTitle>
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-100 dark:bg-amber-900/30">
              <Coins className="h-4 w-4 text-amber-600 dark:text-amber-400" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {!data.freeTrialUsed ? '무료 1회' : `${data.creditBalance}개`}
            </div>
            <Link href="/credits" className="text-xs text-primary hover:underline">
              충전하기
            </Link>
          </CardContent>
        </Card>
      </div>

      {/* Recent Sessions */}
      <Card>
        <CardHeader>
          <CardTitle>최근 면접 기록</CardTitle>
          <CardDescription>최근 완료한 면접 세션입니다</CardDescription>
        </CardHeader>
        <CardContent>
          {data.recentSessions.length === 0 ? (
            <div className="py-12 text-center">
              <div className="mx-auto mb-6 flex h-20 w-20 items-center justify-center rounded-full bg-primary/10">
                <Mic className="h-10 w-10 text-primary animate-pulse" />
              </div>
              <p className="text-lg font-medium">첫 음성 면접을 시작해보세요</p>
              <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
                이력서를 업로드하면 AI가 맞춤 질문을 생성하고, 음성으로 답변하며 실전 감각을 키울 수 있습니다.
              </p>
              <div className="mx-auto mt-6 grid max-w-sm gap-3 text-left text-sm">
                <div className="flex items-center gap-3 rounded-lg border p-3">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">1</div>
                  <span>이력서 PDF 업로드</span>
                </div>
                <div className="flex items-center gap-3 rounded-lg border p-3">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">2</div>
                  <span>AI가 맞춤 질문 설계</span>
                </div>
                <div className="flex items-center gap-3 rounded-lg border p-3">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">3</div>
                  <span>음성 답변 + 실시간 피드백</span>
                </div>
              </div>
              <Link href="/interview/setup">
                <Button className="mt-6" size="lg">
                  첫 면접 시작하기
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Button>
              </Link>
            </div>
          ) : (
            <div className="space-y-3">
              {data.recentSessions.map((s) => (
                <Link
                  key={s.id}
                  href={`/interview/report/${s.id}`}
                  className="flex items-center justify-between rounded-lg border p-4 transition-all duration-200 hover:bg-accent hover:shadow-sm hover:border-primary/20"
                >
                  <div>
                    <p className="font-medium">
                      {s.type === 'TECHNICAL' ? '기술면접' : s.type === 'BEHAVIORAL' ? '인성면접' : '혼합면접'}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {(s.categories ?? []).join(', ')}{(s.categories ?? []).length > 0 && ' | '}{new Date(s.createdAt).toLocaleDateString('ko-KR')}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-lg font-bold">{s.overallScore ?? '-'}점</p>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Growth Chart */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <TrendingUp className="h-5 w-5" />
            점수 추이
          </CardTitle>
          <CardDescription>면접 세션별 종합 점수 변화</CardDescription>
        </CardHeader>
        <CardContent>
          {data.growthData.length > 0 ? (
            <GrowthChart data={data.growthData} />
          ) : (
            <p className="py-8 text-center text-sm text-muted-foreground">
              면접을 2회 이상 완료하면 성장 추이를 확인할 수 있습니다
            </p>
          )}
        </CardContent>
      </Card>

      {/* Category Performance */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <BarChart3 className="h-5 w-5" />
            카테고리별 성과
          </CardTitle>
          <CardDescription>영역별 평균 점수</CardDescription>
        </CardHeader>
        <CardContent>
          {data.categoryPerformance.length > 0 ? (
            <CategoryChart data={data.categoryPerformance} />
          ) : (
            <p className="py-8 text-center text-sm text-muted-foreground">
              면접 데이터가 쌓이면 카테고리별 분석을 확인할 수 있습니다
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
