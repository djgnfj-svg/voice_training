import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { creditService } from '@/services/credit.service';

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: '로그인이 필요합니다' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const limit = Math.min(Number(searchParams.get('limit')) || 20, 100);
  const offset = Number(searchParams.get('offset')) || 0;

  const transactions = await creditService.getTransactions(session.user.id, limit, offset);
  return NextResponse.json(transactions);
}
