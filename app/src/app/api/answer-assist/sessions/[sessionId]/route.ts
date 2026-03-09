import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { isAdmin } from '@/lib/admin';
import { prisma } from '@/lib/prisma';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const session = await auth();
  if (!session?.user?.id || !isAdmin(session.user.email)) {
    return NextResponse.json({ error: '권한이 없습니다' }, { status: 403 });
  }

  const { sessionId } = await params;

  const assistSession = await prisma.answerAssistSession.findFirst({
    where: { id: sessionId, userId: session.user.id },
    include: {
      resume: { select: { name: true, parsedData: true } },
      items: { orderBy: { questionIndex: 'asc' } },
    },
  });

  if (!assistSession) {
    return NextResponse.json({ error: '세션을 찾을 수 없습니다' }, { status: 404 });
  }

  return NextResponse.json(assistSession);
}
