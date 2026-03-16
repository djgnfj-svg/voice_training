import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { captureError } from '@/lib/error';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: '로그인이 필요합니다' }, { status: 401 });
  }

  const { id } = await params;

  try {
    const log = await prisma.activityLog.findFirst({
      where: { id, userId: session.user.id },
      include: {
        resume: { select: { name: true } },
        items: { orderBy: { index: 'asc' } },
      },
    });

    if (!log) {
      return NextResponse.json({ error: '활동 기록을 찾을 수 없습니다' }, { status: 404 });
    }

    return NextResponse.json(log);
  } catch (error) {
    captureError(error, { context: 'activity-log-fetch' });
    return NextResponse.json({ error: '활동 기록을 불러오는 중 오류가 발생했습니다' }, { status: 500 });
  }
}
