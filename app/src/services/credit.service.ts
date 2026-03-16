import type { CreditTxType } from '@prisma/client';
import { prisma } from '@/lib/prisma';

export const CREDIT_COSTS = {
  SESSION: 10,
  MODEL_ANSWER: 10,
  DEEP_RESEARCH: 10,
  FOLLOW_UP: 1,
} as const;

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
    if (info.balance >= CREDIT_COSTS.SESSION) {
      return { allowed: true, usingFreeTrial: false };
    }
    return { allowed: false, usingFreeTrial: false };
  }

  async deductForSession(userId: string, sessionId: string, usingFreeTrial: boolean) {

    if (usingFreeTrial) {
      // 원자적 조건부 업데이트로 race condition 방지
      await prisma.$transaction(async (tx) => {
        const updated = await tx.user.updateMany({
          where: { id: userId, freeTrialUsed: false },
          data: { freeTrialUsed: true },
        });

        if (updated.count === 0) {
          throw new Error('FREE_TRIAL_ALREADY_USED');
        }

        await tx.interviewSession.update({
          where: { id: sessionId },
          data: { creditDeducted: true },
        });

        await tx.creditTransaction.create({
          data: {
            userId,
            amount: 0,
            balance: 0,
            type: 'FREE_TRIAL',
            description: '무료 체험 사용',
            referenceId: sessionId,
          },
        });
      });
      return;
    }

    // Atomic deduction: only succeeds if balance >= cost
    await prisma.$transaction(async (tx) => {
      const updated = await tx.user.updateMany({
        where: { id: userId, creditBalance: { gte: CREDIT_COSTS.SESSION } },
        data: { creditBalance: { decrement: CREDIT_COSTS.SESSION } },
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
          amount: -CREDIT_COSTS.SESSION,
          balance: user!.creditBalance,
          type: 'SESSION_DEBIT',
          description: '면접 세션 사용',
          referenceId: sessionId,
        },
      });
    });
  }

  async deductForFeature(userId: string, referenceId: string, description: string, cost: number, txType: CreditTxType = 'FEATURE_DEBIT') {

    await prisma.$transaction(async (tx) => {
      const updated = await tx.user.updateMany({
        where: { id: userId, creditBalance: { gte: cost } },
        data: { creditBalance: { decrement: cost } },
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
          amount: -cost,
          balance: user!.creditBalance,
          type: txType,
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
        data: { creditBalance: { increment: CREDIT_COSTS.SESSION } },
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
          amount: CREDIT_COSTS.SESSION,
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
      skip: Math.max(0, offset),
    });
  }
}

export const creditService = new CreditService();
