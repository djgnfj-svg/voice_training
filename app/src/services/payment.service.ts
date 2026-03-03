import { prisma } from '@/lib/prisma';
import { findProduct } from '@/lib/payment-products';
import { randomUUID } from 'crypto';

const TOSS_CONFIRM_URL = 'https://api.tosspayments.com/v1/payments/confirm';

export class PaymentService {
  /**
   * 주문 생성 (PENDING)
   */
  async createOrder(userId: string, productId: string) {
    const product = findProduct(productId);
    if (!product) {
      throw new Error('INVALID_PRODUCT');
    }

    const orderId = `order_${Date.now()}_${randomUUID().slice(0, 8)}`;

    const order = await prisma.paymentOrder.create({
      data: {
        userId,
        orderId,
        orderName: `${product.label} 충전`,
        amount: product.amount,
        credits: product.credits,
        status: 'PENDING',
      },
    });

    return {
      orderId: order.orderId,
      amount: order.amount,
      orderName: order.orderName,
    };
  }

  /**
   * 결제 확인 + 크레딧 부여 (원자적)
   */
  async confirmPayment(
    userId: string,
    paymentKey: string,
    orderId: string,
    amount: number,
  ) {
    // 1. 주문 조회
    const order = await prisma.paymentOrder.findUnique({
      where: { orderId },
    });

    if (!order) {
      throw new Error('ORDER_NOT_FOUND');
    }

    // 유저 격리 체크
    if (order.userId !== userId) {
      throw new Error('ORDER_USER_MISMATCH');
    }

    // 이미 완료된 주문 → 멱등성 (재처리 없이 성공)
    if (order.status === 'DONE') {
      return { credits: order.credits, alreadyProcessed: true };
    }

    // PENDING이 아닌 다른 상태 (FAILED, CANCELED)
    if (order.status !== 'PENDING') {
      throw new Error('ORDER_NOT_PENDING');
    }

    // 금액 검증 (클라이언트 변조 방지)
    if (order.amount !== amount) {
      await prisma.paymentOrder.update({
        where: { orderId },
        data: { status: 'FAILED', failReason: '금액 불일치' },
      });
      throw new Error('AMOUNT_MISMATCH');
    }

    // 2. Toss confirm API 호출
    const secretKey = process.env.TOSS_SECRET_KEY;
    if (!secretKey) {
      throw new Error('TOSS_SECRET_KEY_NOT_SET');
    }

    const tossResponse = await fetch(TOSS_CONFIRM_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${secretKey}:`).toString('base64')}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': orderId,
      },
      body: JSON.stringify({ paymentKey, orderId, amount }),
    });

    const tossData = await tossResponse.json();

    if (!tossResponse.ok) {
      await prisma.paymentOrder.update({
        where: { orderId },
        data: {
          status: 'FAILED',
          failReason: tossData.message || tossData.code || 'Toss API 오류',
          raw: tossData,
        },
      });
      throw new Error(tossData.message || 'TOSS_CONFIRM_FAILED');
    }

    // 3. 원자적 처리: 주문 상태 업데이트 + 크레딧 부여 + 거래 내역
    await prisma.$transaction(async (tx) => {
      await tx.paymentOrder.update({
        where: { orderId },
        data: {
          status: 'DONE',
          paymentKey,
          method: tossData.method ?? null,
          approvedAt: tossData.approvedAt ? new Date(tossData.approvedAt) : new Date(),
          raw: tossData,
        },
      });

      await tx.user.update({
        where: { id: userId },
        data: { creditBalance: { increment: order.credits } },
      });

      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { creditBalance: true },
      });

      await tx.creditTransaction.create({
        data: {
          userId,
          amount: order.credits,
          balance: user!.creditBalance,
          type: 'PURCHASE',
          description: order.orderName,
          referenceId: order.id,
        },
      });
    });

    return { credits: order.credits, alreadyProcessed: false };
  }

  /**
   * 주문 실패 처리
   */
  async failOrder(orderId: string, reason: string) {
    await prisma.paymentOrder.updateMany({
      where: { orderId, status: 'PENDING' },
      data: { status: 'FAILED', failReason: reason },
    });
  }
}

export const paymentService = new PaymentService();
