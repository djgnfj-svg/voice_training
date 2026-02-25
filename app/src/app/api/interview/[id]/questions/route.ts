import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

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
          },
        },
      },
    });

    if (!interviewSession) {
      return NextResponse.json({ error: '세션을 찾을 수 없습니다' }, { status: 404 });
    }

    const questions = interviewSession.answers.map((a) => ({
      index: a.questionIndex,
      text: a.questionText,
      source: a.questionSource,
      category: interviewSession.categories[0] || 'general',
      difficulty: interviewSession.difficulty,
    }));

    return NextResponse.json({ questions });
  } catch (error) {
    console.error('Questions fetch error:', error);
    return NextResponse.json({ error: '질문 조회에 실패했습니다' }, { status: 500 });
  }
}
