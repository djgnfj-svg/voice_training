import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { analyticsService } from '@/services/analytics.service';

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const [sessionCount, recentSessions, resumeCount, user, growthData, categoryPerformance] = await Promise.all([
      prisma.interviewSession.count({
        where: { userId: session.user.id, status: 'COMPLETED' },
      }),
      prisma.interviewSession.findMany({
        where: { userId: session.user.id, status: 'COMPLETED' },
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: { id: true, type: true, overallScore: true, createdAt: true, categories: true },
      }),
      prisma.resume.count({
        where: { userId: session.user.id },
      }),
      prisma.user.findUnique({
        where: { id: session.user.id },
        select: { creditBalance: true, freeTrialUsed: true },
      }),
      analyticsService.getGrowthData(session.user.id),
      analyticsService.getCategoryPerformance(session.user.id),
    ]);

    return NextResponse.json({
      sessionCount,
      recentSessions,
      resumeCount,
      creditBalance: user?.creditBalance ?? 0,
      freeTrialUsed: user?.freeTrialUsed ?? false,
      userName: session.user.name,
      growthData,
      categoryPerformance,
    });
  } catch (error) {
    console.error('Dashboard data fetch error:', error);
    return NextResponse.json({ error: '대시보드 데이터를 불러오는 중 오류가 발생했습니다' }, { status: 500 });
  }
}
