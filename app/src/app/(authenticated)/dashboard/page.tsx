'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Mic, History, TrendingUp, FileText, Coins, Loader2, BarChart3 } from 'lucide-react';
import { GrowthChart } from '@/components/analytics/growth-chart';
import { CategoryChart } from '@/components/analytics/category-chart';
import type { GrowthData, CategoryPerformance } from '@/types';

interface DashboardData {
  sessionCount: number;
  recentSessions: {
    id: string;
    type: string;
    overallScore: number | null;
    createdAt: string;
    categories: string[];
  }[];
  resumeCount: number;
  creditBalance: number;
  freeTrialUsed: boolean;
  userName: string | null;
  growthData: GrowthData[];
  categoryPerformance: CategoryPerformance[];
}

export default function DashboardPage() {
  const { data, isLoading } = useQuery<DashboardData>({
    queryKey: ['dashboard'],
    queryFn: async () => {
      const res = await fetch('/api/dashboard');
      if (!res.ok) throw new Error('Failed to fetch');
      return res.json();
    },
  });

  if (isLoading || !data) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const avgScore =
    data.recentSessions.length > 0
      ? Math.round(
          data.recentSessions
            .filter((s) => s.overallScore !== null)
            .reduce((sum, s) => sum + (s.overallScore || 0), 0) /
            data.recentSessions.filter((s) => s.overallScore !== null).length
        )
      : 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold md:text-3xl">대시보드</h1>
        <p className="text-muted-foreground">안녕하세요, {data.userName}님!</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">총 면접 횟수</CardTitle>
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-100">
              <History className="h-4 w-4 text-blue-600" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{data.sessionCount}회</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">최근 평균 점수</CardTitle>
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-green-100">
              <TrendingUp className="h-4 w-4 text-green-600" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{avgScore}점</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">이력서</CardTitle>
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-purple-100">
              <FileText className="h-4 w-4 text-purple-600" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{data.resumeCount}개</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">크레딧</CardTitle>
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-100">
              <Coins className="h-4 w-4 text-amber-600" />
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
              <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-primary/10">
                <Mic className="h-8 w-8 text-primary" />
              </div>
              <p className="text-lg font-medium">아직 면접 기록이 없습니다</p>
              <p className="mt-1 text-sm text-muted-foreground">첫 면접을 시작해보세요!</p>
              <Link href="/interview/setup">
                <Button className="mt-4">첫 면접 시작하기</Button>
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
                      {s.categories.join(', ')} | {new Date(s.createdAt).toLocaleDateString('ko-KR')}
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
