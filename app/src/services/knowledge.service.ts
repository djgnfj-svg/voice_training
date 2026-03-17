import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';

export class KnowledgeService {
  async getUserKnowledge(userId: string, subjectId?: string) {
    const where: Record<string, unknown> = { userId };
    if (subjectId) {
      where.topic = { subjectId };
    }

    return prisma.userKnowledge.findMany({
      where,
      include: { topic: { select: { id: true, name: true, subjectId: true } } },
      orderBy: { proficiency: 'asc' },
    });
  }

  async getWeakTopics(userId: string, subjectId: string, limit = 5) {
    return prisma.userKnowledge.findMany({
      where: {
        userId,
        topic: { subjectId },
        proficiency: { lt: 60 },
      },
      include: { topic: true },
      orderBy: { proficiency: 'asc' },
      take: limit,
    });
  }

  async getDueForReview(userId: string, limit = 10) {
    return prisma.userKnowledge.findMany({
      where: {
        userId,
        nextReviewAt: { lte: new Date() },
      },
      include: { topic: { include: { subject: { select: { id: true, name: true } } } } },
      orderBy: { nextReviewAt: 'asc' },
      take: limit,
    });
  }

  /**
   * SM-2 간소화 알고리즘으로 숙련도 갱신
   */
  async updateKnowledge(userId: string, topicId: string, wasCorrect: boolean, score: number, metadata?: Prisma.InputJsonValue) {
    const existing = await prisma.userKnowledge.findUnique({
      where: { userId_topicId: { userId, topicId } },
    });

    const now = new Date();

    if (!existing) {
      // 첫 학습
      const proficiency = wasCorrect ? Math.round(score * 0.5) : 10;
      const nextReview = new Date(now.getTime() + (wasCorrect ? 3 : 1) * 24 * 60 * 60 * 1000);

      return prisma.userKnowledge.create({
        data: {
          userId,
          topicId,
          proficiency,
          successCount: wasCorrect ? 1 : 0,
          failureCount: wasCorrect ? 0 : 1,
          streakCount: wasCorrect ? 1 : 0,
          lastPracticed: now,
          nextReviewAt: nextReview,
          ...(metadata ? { metadata } : {}),
        },
      });
    }

    let newProficiency: number;
    let newStreak: number;
    let nextReview: Date;

    if (wasCorrect) {
      // 정답: proficiency += (100 - proficiency) * 0.2
      newProficiency = Math.round(existing.proficiency + (100 - existing.proficiency) * 0.2);
      newStreak = existing.streakCount + 1;
      // nextReview = now + base(1일) * 1.5^streak
      const baseDays = 1;
      const intervalDays = baseDays * Math.pow(1.5, newStreak);
      nextReview = new Date(now.getTime() + Math.min(intervalDays, 30) * 24 * 60 * 60 * 1000);
    } else {
      // 오답: proficiency -= proficiency * 0.15
      newProficiency = Math.round(existing.proficiency - existing.proficiency * 0.15);
      newStreak = 0;
      nextReview = new Date(now.getTime() + 1 * 24 * 60 * 60 * 1000);
    }

    newProficiency = Math.max(0, Math.min(100, newProficiency));

    return prisma.userKnowledge.update({
      where: { userId_topicId: { userId, topicId } },
      data: {
        proficiency: newProficiency,
        successCount: wasCorrect ? { increment: 1 } : undefined,
        failureCount: wasCorrect ? undefined : { increment: 1 },
        streakCount: newStreak,
        lastPracticed: now,
        nextReviewAt: nextReview,
        ...(metadata ? { metadata } : {}),
      },
    });
  }

  async getSubjectProficiency(userId: string, subjectId: string): Promise<number> {
    const result = await prisma.userKnowledge.aggregate({
      where: { userId, topic: { subjectId } },
      _avg: { proficiency: true },
    });
    return Math.round(result._avg.proficiency ?? 0);
  }
}

export const knowledgeService = new KnowledgeService();
