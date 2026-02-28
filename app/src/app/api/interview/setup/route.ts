import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { checkRateLimit } from '@/lib/rate-limit';
import { prisma } from '@/lib/prisma';
import { questionService } from '@/services/question.service';
import { creditService } from '@/services/credit.service';
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

    const rateLimit = await checkRateLimit(session.user.id, 'ai-heavy');
    if (!rateLimit.success) {
      return NextResponse.json(
        { error: '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.' },
        { status: 429, headers: { 'Retry-After': String(rateLimit.resetAt - Math.floor(Date.now() / 1000)) } },
      );
    }

    const body = await request.json();
    const { resumeId, jobPostingId, deepMode } = setupSchema.parse(body);

    // Credit check
    const creditCheck = await creditService.canStartSession(session.user.id);
    if (!creditCheck.allowed) {
      return NextResponse.json(
        { error: '크레딧이 부족합니다. 크레딧을 충전해주세요.', code: 'INSUFFICIENT_CREDITS' },
        { status: 402 },
      );
    }

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

    // Free trial: limit to 3 questions
    if (creditCheck.usingFreeTrial) {
      plan.totalQuestions = Math.min(plan.totalQuestions, 3);
    }

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

    // Deduct credit after successful session creation
    await creditService.deductForSession(session.user.id, interviewSession.id, creditCheck.usingFreeTrial);

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
