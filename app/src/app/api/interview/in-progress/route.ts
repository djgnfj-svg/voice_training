import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: '로그인이 필요합니다' }, { status: 401 });
    }

    const interviewSession = await prisma.interviewSession.findFirst({
      where: {
        userId: session.user.id,
        status: 'IN_PROGRESS',
        createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        type: true,
        totalQuestions: true,
        createdAt: true,
        answers: {
          where: { answerTranscript: { not: null } },
          select: { id: true },
        },
      },
    });

    if (!interviewSession) {
      return NextResponse.json({ session: null });
    }

    return NextResponse.json({
      session: {
        id: interviewSession.id,
        type: interviewSession.type,
        totalQuestions: interviewSession.totalQuestions,
        answeredCount: interviewSession.answers.length,
        createdAt: interviewSession.createdAt,
      },
    });
  } catch (error) {
    console.error('In-progress session fetch error:', error);
    return NextResponse.json({ error: '조회에 실패했습니다' }, { status: 500 });
  }
}
