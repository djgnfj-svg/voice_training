import { prisma } from '@/lib/prisma';

export class CreditService {
  async getBalance(userId: string): Promise<number> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { creditBalance: true },
    });
    return user?.creditBalance ?? 0;
  }

  async getCreditInfo(userId: string) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { creditBalance: true, freeTrialUsed: true },
    });
    return {
      balance: user?.creditBalance ?? 0,
      freeTrialUsed: user?.freeTrialUsed ?? false,
    };
  }

  async canStartSession(userId: string): Promise<{ allowed: boolean; usingFreeTrial: boolean }> {
    const info = await this.getCreditInfo(userId);

    if (!info.freeTrialUsed) {
      return { allowed: true, usingFreeTrial: true };
    }
    if (info.balance >= 1) {
      return { allowed: true, usingFreeTrial: false };
    }
    return { allowed: false, usingFreeTrial: false };
  }

  async deductForSession(userId: string, sessionId: string, usingFreeTrial: boolean) {

    if (usingFreeTrial) {
      await prisma.$transaction([
        prisma.user.update({
          where: { id: userId },
          data: { freeTrialUsed: true },
        }),
        prisma.interviewSession.update({
          where: { id: sessionId },
          data: { creditDeducted: true },
        }),
        prisma.creditTransaction.create({
          data: {
            userId,
            amount: 0,
            balance: 0,
            type: 'FREE_TRIAL',
            description: '무료 체험 사용',
            referenceId: sessionId,
          },
        }),
      ]);
      return;
    }

    // Atomic deduction: only succeeds if balance >= 1
    await prisma.$transaction(async (tx) => {
      const updated = await tx.user.updateMany({
        where: { id: userId, creditBalance: { gte: 1 } },
        data: { creditBalance: { decrement: 1 } },
      });

      if (updated.count === 0) {
        throw new Error('INSUFFICIENT_CREDITS');
      }

      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { creditBalance: true },
      });

      await tx.interviewSession.update({
        where: { id: sessionId },
        data: { creditDeducted: true },
      });

      await tx.creditTransaction.create({
        data: {
          userId,
          amount: -1,
          balance: user!.creditBalance,
          type: 'SESSION_DEBIT',
          description: '면접 세션 사용',
          referenceId: sessionId,
        },
      });
    });
  }

  async deductForFeature(userId: string, referenceId: string, description: string) {

    await prisma.$transaction(async (tx) => {
      const updated = await tx.user.updateMany({
        where: { id: userId, creditBalance: { gte: 1 } },
        data: { creditBalance: { decrement: 1 } },
      });

      if (updated.count === 0) {
        throw new Error('INSUFFICIENT_CREDITS');
      }

      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { creditBalance: true },
      });

      await tx.creditTransaction.create({
        data: {
          userId,
          amount: -1,
          balance: user!.creditBalance,
          type: 'SESSION_DEBIT',
          description,
          referenceId,
        },
      });
    });
  }

  async refundForSession(userId: string, sessionId: string) {

    const session = await prisma.interviewSession.findUnique({
      where: { id: sessionId },
      select: { creditDeducted: true },
    });

    if (!session?.creditDeducted) return;

    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: { creditBalance: { increment: 1 } },
      });

      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { creditBalance: true },
      });

      await tx.interviewSession.update({
        where: { id: sessionId },
        data: { creditDeducted: false },
      });

      await tx.creditTransaction.create({
        data: {
          userId,
          amount: 1,
          balance: user!.creditBalance,
          type: 'REFUND',
          description: '세션 생성 실패 환불',
          referenceId: sessionId,
        },
      });
    });
  }

  async grantCredits(userId: string, amount: number, description: string) {
    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: { creditBalance: { increment: amount } },
      });

      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { creditBalance: true },
      });

      await tx.creditTransaction.create({
        data: {
          userId,
          amount,
          balance: user!.creditBalance,
          type: 'ADMIN_GRANT',
          description,
        },
      });
    });
  }

  async getTransactions(userId: string, limit = 20, offset = 0) {
    return prisma.creditTransaction.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
    });
  }
}

export const creditService = new CreditService();
