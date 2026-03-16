import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { creditService } from '@/services/credit.service';
import { captureError } from '@/lib/error';

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: '로그인이 필요합니다' }, { status: 401 });
  }

  try {
    const info = await creditService.getCreditInfo(session.user.id);
    return NextResponse.json(info);
  } catch (error) {
    captureError(error, { context: 'credit-info-fetch' });
    return NextResponse.json({ error: '크레딧 정보를 불러오는 중 오류가 발생했습니다' }, { status: 500 });
  }
}
