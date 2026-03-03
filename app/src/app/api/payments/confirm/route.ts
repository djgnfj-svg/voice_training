import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { paymentService } from '@/services/payment.service';

const schema = z.object({
  paymentKey: z.string(),
  orderId: z.string(),
  amount: z.number().int().positive(),
});

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: '로그인이 필요합니다' }, { status: 401 });
  }

  const body = await request.json();
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: '잘못된 요청입니다' }, { status: 400 });
  }

  try {
    const result = await paymentService.confirmPayment(
      session.user.id,
      parsed.data.paymentKey,
      parsed.data.orderId,
      parsed.data.amount,
    );
    return NextResponse.json({ success: true, credits: result.credits });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Unknown error';

    if (message === 'ORDER_NOT_FOUND') {
      return NextResponse.json({ error: '주문을 찾을 수 없습니다' }, { status: 404 });
    }
    if (message === 'ORDER_USER_MISMATCH') {
      return NextResponse.json({ error: '권한이 없습니다' }, { status: 403 });
    }
    if (message === 'AMOUNT_MISMATCH') {
      return NextResponse.json({ error: '결제 금액이 일치하지 않습니다' }, { status: 400 });
    }
    if (message === 'ORDER_NOT_PENDING') {
      return NextResponse.json({ error: '처리할 수 없는 주문 상태입니다' }, { status: 400 });
    }

    console.error('[payments/confirm] error:', message);
    return NextResponse.json({ error: '결제 확인 실패' }, { status: 500 });
  }
}
