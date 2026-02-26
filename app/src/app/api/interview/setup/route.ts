import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { questionService } from '@/services/question.service';
import { z } from 'zod';

const setupSchema = z.object({
  resumeId: z.string(),
  jobPostingId: z.string().optional(),
  deepMode: z.boolean().optional().default(false),
});

export async function POST(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: '로그인이 필요합니다' }, { status: 401 });
    }

    const body = await request.json();
    const { resumeId, jobPostingId, deepMode } = setupSchema.parse(body);

    // Verify resume ownership
    const resume = await prisma.resume.findFirst({
      where: { id: resumeId, userId: session.user.id },
    });
    if (!resume) {
      return NextResponse.json({ error: '이력서를 찾을 수 없습니다' }, { status: 404 });
    }

    // AI가 면접 설정 자동 결정
    const plan = await questionService.planInterview({
      resumeId,
      jobPostingId,
      userId: session.user.id,
      deepMode,
    });

    // 결정된 설정으로 질문 생성
    const questions = await questionService.generateQuestions({
      type: plan.type,
      categories: plan.categories,
      difficulty: plan.difficulty,
      totalQuestions: plan.totalQuestions,
      resumeId,
      jobPostingId,
      userId: session.user.id,
      deepMode,
    });

    // Create session
    const interviewSession = await prisma.interviewSession.create({
      data: {
        userId: session.user.id,
        resumeId,
        jobPostingId: jobPostingId || null,
        type: plan.type,
        categories: plan.categories,
        difficulty: plan.difficulty,
        totalQuestions: plan.totalQuestions,
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
      plan,
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
