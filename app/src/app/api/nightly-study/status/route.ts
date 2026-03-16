import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { getKstMidnight } from '@/lib/date';

export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: '로그인이 필요합니다' }, { status: 401 });
    }

    if (process.env.NODE_ENV === 'development') {
      return NextResponse.json({ dailyLimitReached: false });
    }

    const kstMidnight = getKstMidnight();
    const todaySession = await prisma.activityLog.findFirst({
      where: {
        userId: session.user.id,
        type: 'NIGHTLY_STUDY',
        createdAt: { gte: kstMidnight },
      },
    });

    return NextResponse.json({ dailyLimitReached: !!todaySession });
  } catch (error) {
    console.error('Nightly study status error:', error);
    return NextResponse.json({ error: '상태 확인에 실패했습니다' }, { status: 500 });
  }
}
