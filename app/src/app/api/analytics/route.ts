import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { analyticsService } from '@/services/analytics.service';

export async function GET(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: '로그인이 필요합니다' }, { status: 401 });
    }

    const [growthData, categoryPerformance] = await Promise.all([
      analyticsService.getGrowthData(session.user.id),
      analyticsService.getCategoryPerformance(session.user.id),
    ]);

    return NextResponse.json({ growthData, categoryPerformance });
  } catch (error) {
    console.error('Analytics fetch error:', error);
    return NextResponse.json({ error: '분석 데이터 조회에 실패했습니다' }, { status: 500 });
  }
}
