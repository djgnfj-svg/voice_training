import { prisma } from '@/lib/prisma';
import type { GrowthData, CategoryPerformance } from '@/types';

export class AnalyticsService {
  async getGrowthData(userId: string): Promise<GrowthData[]> {
    const sessions = await prisma.interviewSession.findMany({
      where: {
        userId,
        status: 'COMPLETED',
        overallScore: { not: null },
      },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        type: true,
        overallScore: true,
        createdAt: true,
      },
    });

    return sessions.map(s => ({
      date: s.createdAt.toISOString().split('T')[0],
      score: s.overallScore!,
      sessionId: s.id,
      type: s.type,
    }));
  }

  async getCategoryPerformance(userId: string): Promise<CategoryPerformance[]> {
    const answers = await prisma.interviewAnswer.findMany({
      where: {
        session: { userId, status: 'COMPLETED' },
        overallScore: { not: null },
      },
      select: {
        questionSource: true,
        overallScore: true,
      },
    });

    const categoryMap = new Map<string, { total: number; count: number }>();
    for (const answer of answers) {
      const cat = answer.questionSource;
      const existing = categoryMap.get(cat) || { total: 0, count: 0 };
      existing.total += answer.overallScore || 0;
      existing.count += 1;
      categoryMap.set(cat, existing);
    }

    return Array.from(categoryMap.entries()).map(([category, data]) => ({
      category,
      averageScore: Math.round(data.total / data.count),
      totalQuestions: data.count,
    }));
  }

  async getSessionHistory(userId: string, limit = 20) {
    return prisma.interviewSession.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        jobPosting: { select: { parsedData: true } },
        _count: { select: { answers: true } },
      },
    });
  }

  async getActivityHistory(userId: string, limit = 20) {
    return prisma.activityLog.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        resume: { select: { name: true } },
        _count: { select: { items: true } },
      },
    });
  }
}

export const analyticsService = new AnalyticsService();
