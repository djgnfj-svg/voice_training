import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { creditService } from '@/services/credit.service';

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: '로그인이 필요합니다' }, { status: 401 });
  }

  const info = await creditService.getCreditInfo(session.user.id);
  return NextResponse.json(info);
}
