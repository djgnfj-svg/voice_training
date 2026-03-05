import { prisma } from '@/lib/prisma';

export type CouponError =
  | 'INVALID_COUPON'
  | 'EXPIRED_COUPON'
  | 'MAX_USES_REACHED'
  | 'ALREADY_USED';

const COUPON_ERROR_MESSAGES: Record<CouponError, string> = {
  INVALID_COUPON: '유효하지 않은 쿠폰 코드입니다.',
  EXPIRED_COUPON: '만료된 쿠폰입니다.',
  MAX_USES_REACHED: '사용 한도에 도달한 쿠폰입니다.',
  ALREADY_USED: '이미 사용한 쿠폰입니다.',
};

export function getCouponErrorMessage(code: CouponError): string {
  return COUPON_ERROR_MESSAGES[code];
}

class CouponService {
  async validateCoupon(code: string, userId: string): Promise<{ valid: true; couponId: string; credits: number } | { valid: false; error: CouponError }> {
    const normalizedCode = code.toUpperCase().trim();

    const coupon = await prisma.coupon.findUnique({
      where: { code: normalizedCode },
      include: {
        usages: {
          where: { userId },
          take: 1,
        },
      },
    });

    if (!coupon || !coupon.isActive) {
      return { valid: false, error: 'INVALID_COUPON' };
    }

    if (coupon.expiresAt && coupon.expiresAt < new Date()) {
      return { valid: false, error: 'EXPIRED_COUPON' };
    }

    if (coupon.maxUses !== null && coupon.usedCount >= coupon.maxUses) {
      return { valid: false, error: 'MAX_USES_REACHED' };
    }

    if (coupon.usages.length > 0) {
      return { valid: false, error: 'ALREADY_USED' };
    }

    return { valid: true, couponId: coupon.id, credits: coupon.credits };
  }

  async redeemCoupon(userId: string, code: string): Promise<{ credits: number }> {
    const normalizedCode = code.toUpperCase().trim();

    return prisma.$transaction(async (tx) => {
      const coupon = await tx.coupon.findUnique({
        where: { code: normalizedCode },
        include: {
          usages: {
            where: { userId },
            take: 1,
          },
        },
      });

      if (!coupon || !coupon.isActive) {
        throw new CouponRedeemError('INVALID_COUPON');
      }

      if (coupon.expiresAt && coupon.expiresAt < new Date()) {
        throw new CouponRedeemError('EXPIRED_COUPON');
      }

      if (coupon.usages.length > 0) {
        throw new CouponRedeemError('ALREADY_USED');
      }

      // Atomic: only increment if under limit
      const whereClause: Record<string, unknown> = { id: coupon.id };
      if (coupon.maxUses !== null) {
        whereClause.usedCount = { lt: coupon.maxUses };
      }

      const updated = await tx.coupon.updateMany({
        where: whereClause,
        data: { usedCount: { increment: 1 } },
      });

      if (updated.count === 0) {
        throw new CouponRedeemError('MAX_USES_REACHED');
      }

      await tx.couponUsage.create({
        data: {
          couponId: coupon.id,
          userId,
        },
      });

      await tx.user.update({
        where: { id: userId },
        data: { creditBalance: { increment: coupon.credits } },
      });

      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { creditBalance: true },
      });

      await tx.creditTransaction.create({
        data: {
          userId,
          amount: coupon.credits,
          balance: user!.creditBalance,
          type: 'COUPON',
          description: `쿠폰 사용: ${normalizedCode}`,
          referenceId: coupon.id,
        },
      });

      return { credits: coupon.credits };
    });
  }
}

export class CouponRedeemError extends Error {
  code: CouponError;

  constructor(code: CouponError) {
    super(getCouponErrorMessage(code));
    this.code = code;
  }
}

export const couponService = new CouponService();
