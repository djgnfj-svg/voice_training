import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { paymentService } from '@/services/payment.service';

const schema = z.object({
  productId: z.string(),
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
    const result = await paymentService.createOrder(session.user.id, parsed.data.productId);
    return NextResponse.json(result);
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Unknown error';
    console.error('[Payment Orders] Error:', e);
    if (message === 'INVALID_PRODUCT') {
      return NextResponse.json({ error: '유효하지 않은 상품입니다' }, { status: 400 });
    }
    return NextResponse.json({ error: '주문 생성 실패' }, { status: 500 });
  }
}
