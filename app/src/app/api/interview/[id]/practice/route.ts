import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { captureError } from '@/lib/error';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: '로그인이 필요합니다' }, { status: 401 });
    }

    const { id } = await params;

    const interviewSession = await prisma.interviewSession.findUnique({
      where: { id, userId: session.user.id },
      include: {
        answers: {
          orderBy: { questionIndex: 'asc' },
          select: {
            questionIndex: true,
            questionText: true,
            questionSource: true,
            answerTranscript: true,
            modelAnswer: true,
            overallScore: true,
            briefFeedback: true,
          },
        },
      },
    });

    if (!interviewSession) {
      return NextResponse.json({ error: '세션을 찾을 수 없습니다' }, { status: 404 });
    }

    if (interviewSession.status !== 'COMPLETED') {
      return NextResponse.json({ error: '완료된 면접만 연습할 수 있습니다' }, { status: 400 });
    }

    return NextResponse.json({
      sessionId: interviewSession.id,
      type: interviewSession.type,
      categories: interviewSession.categories,
      difficulty: interviewSession.difficulty,
      answers: interviewSession.answers,
    });
  } catch (error) {
    captureError(error, { context: 'practice-data-fetch' });
    return NextResponse.json({ error: '연습 데이터 조회에 실패했습니다' }, { status: 500 });
  }
}
