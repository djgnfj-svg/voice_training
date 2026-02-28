'use client';

import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Loader2, TrendingUp, BarChart3 } from 'lucide-react';
import { GrowthChart } from '@/components/analytics/growth-chart';
import { CategoryChart } from '@/components/analytics/category-chart';
import type { GrowthData, CategoryPerformance } from '@/types';

interface AnalyticsData {
  growthData: GrowthData[];
  categoryPerformance: CategoryPerformance[];
}

export default function AnalyticsPage() {
  const { data, isLoading } = useQuery<AnalyticsData>({
    queryKey: ['analytics'],
    queryFn: async () => {
      const res = await fetch('/api/analytics');
      if (!res.ok) throw new Error('Failed to load analytics');
      return res.json();
    },
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold md:text-3xl">성장 분석</h1>
        <p className="text-muted-foreground">면접 실력의 성장 추이를 확인하세요</p>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : data ? (
        <>
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
        </>
      ) : null}
    </div>
  );
}
