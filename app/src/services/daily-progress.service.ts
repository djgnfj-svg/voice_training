import { prisma } from '@/lib/prisma';

export class DailyProgressService {
  private getDateOnly(date: Date = new Date()): Date {
    return new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  }

  async recordProgress(userId: string, sessionData: {
    subjectId: string;
    totalQuestions: number;
    correctCount: number;
    durationSeconds: number;
    topicsStudied: string[];
  }) {
    const today = this.getDateOnly();

    await prisma.dailyProgress.upsert({
      where: { userId_date: { userId, date: today } },
      create: {
        userId,
        date: today,
        totalSessions: 1,
        totalQuestions: sessionData.totalQuestions,
        totalCorrect: sessionData.correctCount,
        totalMinutes: Math.ceil(sessionData.durationSeconds / 60),
        topicsStudied: sessionData.topicsStudied,
        subjectsStudied: [sessionData.subjectId],
        streakDay: await this.calculateStreakDay(userId),
      },
      update: {
        totalSessions: { increment: 1 },
        totalQuestions: { increment: sessionData.totalQuestions },
        totalCorrect: { increment: sessionData.correctCount },
        totalMinutes: { increment: Math.ceil(sessionData.durationSeconds / 60) },
        topicsStudied: {
          push: sessionData.topicsStudied,
        },
        subjectsStudied: {
          push: [sessionData.subjectId],
        },
      },
    });
  }

  async getDailyProgress(userId: string, date?: Date) {
    const targetDate = this.getDateOnly(date);

    return prisma.dailyProgress.findUnique({
      where: { userId_date: { userId, date: targetDate } },
    });
  }

  async getStreak(userId: string): Promise<number> {
    const today = this.getDateOnly();
    let streak = 0;
    let checkDate = today;

    while (true) {
      const progress = await prisma.dailyProgress.findUnique({
        where: { userId_date: { userId, date: checkDate } },
      });

      if (!progress || progress.totalSessions === 0) {
        // 오늘이면 아직 안 한 것이므로 어제부터 체크
        if (streak === 0 && checkDate.getTime() === today.getTime()) {
          checkDate = new Date(checkDate.getTime() - 24 * 60 * 60 * 1000);
          continue;
        }
        break;
      }

      streak++;
      checkDate = new Date(checkDate.getTime() - 24 * 60 * 60 * 1000);
    }

    return streak;
  }

  private async calculateStreakDay(userId: string): Promise<number> {
    const streak = await this.getStreak(userId);
    return streak + 1; // 오늘 포함
  }

  async getWeeklyOverview(userId: string) {
    const today = this.getDateOnly();
    const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);

    const progress = await prisma.dailyProgress.findMany({
      where: {
        userId,
        date: { gte: weekAgo, lte: today },
      },
      orderBy: { date: 'asc' },
    });

    // 7일 배열 (빈 날은 null)
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const date = new Date(today.getTime() - i * 24 * 60 * 60 * 1000);
      const dateStr = date.toISOString().split('T')[0];
      const found = progress.find(p => p.date.toISOString().split('T')[0] === dateStr);
      days.push({
        date: dateStr,
        totalSessions: found?.totalSessions ?? 0,
        totalQuestions: found?.totalQuestions ?? 0,
        totalCorrect: found?.totalCorrect ?? 0,
        totalMinutes: found?.totalMinutes ?? 0,
      });
    }

    return days;
  }
}

export const dailyProgressService = new DailyProgressService();
