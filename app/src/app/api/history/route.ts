import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { analyticsService } from '@/services/analytics.service';

export async function GET(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: '로그인이 필요합니다' }, { status: 401 });
    }

    const searchParams = request.nextUrl.searchParams;
    const limit = parseInt(searchParams.get('limit') || '20');

    const history = await analyticsService.getSessionHistory(session.user.id, limit);
    return NextResponse.json(history);
  } catch (error) {
    console.error('History fetch error:', error);
    return NextResponse.json({ error: '히스토리 조회에 실패했습니다' }, { status: 500 });
  }
}
