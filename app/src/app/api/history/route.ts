import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { analyticsService } from '@/services/analytics.service';
import { captureError } from '@/lib/error';

export async function GET(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: '로그인이 필요합니다' }, { status: 401 });
    }

    const searchParams = request.nextUrl.searchParams;
    const limit = Math.min(Math.max(parseInt(searchParams.get('limit') || '20', 10) || 20, 1), 100);

    const [sessions, activities] = await Promise.all([
      analyticsService.getSessionHistory(session.user.id, limit),
      analyticsService.getActivityHistory(session.user.id, limit),
    ]);

    const sessionItems = sessions.map((s) => ({
      ...s,
      _kind: 'session' as const,
    }));

    const activityItems = activities.map((a) => ({
      ...a,
      _kind: 'activity' as const,
    }));

    const merged = [...sessionItems, ...activityItems]
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, limit);

    return NextResponse.json(merged);
  } catch (error) {
    captureError(error, { context: 'history-fetch' });
    return NextResponse.json({ error: '히스토리 조회에 실패했습니다' }, { status: 500 });
  }
}
