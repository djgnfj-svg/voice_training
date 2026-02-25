import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { questionService } from '@/services/question.service';
import { z } from 'zod';

const setupSchema = z.object({
  jobPostingId: z.string().optional(),
  type: z.enum(['TECHNICAL', 'BEHAVIORAL', 'MIXED']),
  categories: z.array(z.string()).min(1),
  difficulty: z.enum(['BEGINNER', 'INTERMEDIATE', 'ADVANCED']),
  totalQuestions: z.number().min(3).max(15).default(5),
});

export async function POST(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: '로그인이 필요합니다' }, { status: 401 });
    }

    const body = await request.json();
    const params = setupSchema.parse(body);

    // Generate questions
    const questions = await questionService.generateQuestions({
      ...params,
      userId: session.user.id,
    });

    // Create session
    const interviewSession = await prisma.interviewSession.create({
      data: {
        userId: session.user.id,
        jobPostingId: params.jobPostingId,
        type: params.type,
        categories: params.categories,
        difficulty: params.difficulty,
        totalQuestions: params.totalQuestions,
        status: 'IN_PROGRESS',
      },
    });

    // Pre-create answer records with questions
    await prisma.interviewAnswer.createMany({
      data: questions.map((q) => ({
        sessionId: interviewSession.id,
        questionIndex: q.index,
        questionText: q.text,
        questionSource: q.source,
      })),
    });

    return NextResponse.json({
      sessionId: interviewSession.id,
      questions,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.errors[0].message }, { status: 400 });
    }
    console.error('Interview setup error:', error);
    return NextResponse.json({ error: '면접 설정에 실패했습니다' }, { status: 500 });
  }
}
