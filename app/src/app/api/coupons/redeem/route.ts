import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { couponService, CouponRedeemError } from '@/services/coupon.service';
import { captureError } from '@/lib/error';
import { z } from 'zod';

const redeemSchema = z.object({
  code: z.string().min(1).max(50),
});

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: '로그인이 필요합니다.' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: '잘못된 요청입니다.' }, { status: 400 });
  }

  const parsed = redeemSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: '쿠폰 코드를 입력해주세요.' }, { status: 400 });
  }

  try {
    const result = await couponService.redeemCoupon(session.user.id, parsed.data.code);
    return NextResponse.json({
      success: true,
      credits: result.credits,
      message: `${result.credits} 크레딧이 지급되었습니다!`,
    });
  } catch (err) {
    if (err instanceof CouponRedeemError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 400 });
    }
    captureError(err, { context: 'coupon-redeem' });
    return NextResponse.json({ error: '쿠폰 사용 중 오류가 발생했습니다.' }, { status: 500 });
  }
}
