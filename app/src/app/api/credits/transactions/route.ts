import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { creditService } from '@/services/credit.service';
import { captureError } from '@/lib/error';

export async function GET(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: '로그인이 필요합니다' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const limit = Math.min(Number(searchParams.get('limit')) || 20, 100);
    const offset = Math.max(Number(searchParams.get('offset')) || 0, 0);

    const transactions = await creditService.getTransactions(session.user.id, limit, offset);
    return NextResponse.json(transactions);
  } catch (error) {
    captureError(error, { context: 'credit-transactions' });
    return NextResponse.json({ error: '거래 내역 조회에 실패했습니다' }, { status: 500 });
  }
}
