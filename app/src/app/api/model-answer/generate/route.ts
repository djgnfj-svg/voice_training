import { randomUUID } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { checkRateLimit } from '@/lib/rate-limit';
import { anthropic, MODELS } from '@/lib/openai';
import { prisma } from '@/lib/prisma';
import { creditService, CREDIT_COSTS } from '@/services/credit.service';
import { questionService } from '@/services/question.service';
import {
  MODEL_ANSWER_RESUME_PROMPT,
  MODEL_ANSWER_WITH_JOB_PROMPT,
} from '@/prompts/model-answer';
import { captureError } from '@/lib/error';

export async function POST(request: NextRequest) {
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

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: '잘못된 요청입니다' }, { status: 400 });
  }
  const { resumeId, jobPostingText } = body as {
    resumeId: string;
    jobPostingText?: string;
  };

  if (!resumeId || typeof resumeId !== 'string') {
    return NextResponse.json({ error: 'resumeId는 필수입니다' }, { status: 400 });
  }

  const resume = await prisma.resume.findFirst({
    where: { id: resumeId, userId: session.user.id },
  });

  if (!resume) {
    return NextResponse.json({ error: '이력서를 찾을 수 없습니다' }, { status: 404 });
  }

  // Credit check
  const creditCheck = await creditService.canStartSession(session.user.id);
  if (!creditCheck.allowed) {
    return NextResponse.json(
      { error: '크레딧이 부족합니다. 크레딧을 충전해주세요.', code: 'INSUFFICIENT_CREDITS' },
      { status: 402 },
    );
  }

  const parsedResume =
    typeof resume.parsedData === 'string'
      ? resume.parsedData
      : JSON.stringify(resume.parsedData, null, 2);

  try {
    // Step 1: Plan interview using existing service
    const plan = await questionService.planInterview({
      resumeId,
      userId: session.user.id,
    });

    // Step 2: Generate questions + model answers
    const promptTemplate = jobPostingText
      ? MODEL_ANSWER_WITH_JOB_PROMPT
      : MODEL_ANSWER_RESUME_PROMPT;

    let prompt = promptTemplate
      .replace('{interviewType}', plan.type)
      .replace('{categories}', plan.categories.join(', '))
      .replace('{difficulty}', plan.difficulty)
      .replace('{totalQuestions}', plan.totalQuestions.toString())
      .replace('{parsedResume}', parsedResume);

    if (jobPostingText) {
      prompt = prompt.replace('{jobPostingText}', jobPostingText);
    }

    const response = await anthropic.messages.create({
      model: MODELS.QUESTION_GEN,
      max_tokens: 8192,
      temperature: 0.7,
      system: 'You must respond with valid JSON only. No markdown, no explanation, just JSON.',
      messages: [{ role: 'user', content: prompt }],
    });

    const textBlock = response.content.find((b) => b.type === 'text');
    let content = textBlock ? textBlock.text : null;

    if (!content) {
      return NextResponse.json({ error: '질문 생성에 실패했습니다' }, { status: 500 });
    }

    // Strip markdown code blocks if present
    content = content.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();

    const parsed = JSON.parse(content);
    const questions = parsed.questions || [];

    // Deduct credit after successful generation
    const refId = `model-answer-${randomUUID()}`;
    if (creditCheck.usingFreeTrial) {
      await prisma.$transaction([
        prisma.user.update({ where: { id: session.user.id }, data: { freeTrialUsed: true } }),
        prisma.creditTransaction.create({
          data: {
            userId: session.user.id,
            amount: 0,
            balance: 0,
            type: 'FREE_TRIAL',
            description: '모범답안 학습 무료 체험',
            referenceId: refId,
          },
        }),
      ]);
    } else {
      await creditService.deductForFeature(session.user.id, refId, '모범답안 학습 사용', CREDIT_COSTS.MODEL_ANSWER);
    }

    // Save activity log for history/review
    let activityLogId: string | null = null;
    try {
      const log = await prisma.activityLog.create({
        data: {
          userId: session.user.id,
          type: 'MODEL_ANSWER',
          resumeId,
          metadata: { plan: JSON.parse(JSON.stringify(plan)), jobPostingText: jobPostingText || null },
          items: {
            create: questions.map((q: { text: string; modelAnswer?: string; keyPoints?: string[]; answerTips?: string[]; category?: string; difficulty?: string }, i: number) => ({
              index: i,
              question: q.text,
              answer: '',
              extra: {
                modelAnswer: q.modelAnswer,
                keyPoints: q.keyPoints,
                answerTips: q.answerTips,
                category: q.category,
                difficulty: q.difficulty,
              },
            })),
          },
        },
      });
      activityLogId = log.id;
    } catch (logError) {
      captureError(logError, { context: 'model-answer-activity-log-save' });
    }

    return NextResponse.json({ plan, questions, activityLogId });
  } catch (error) {
    captureError(error, { context: 'model-answer-generation' });
    return NextResponse.json(
      { error: '모범답안 생성 중 오류가 발생했습니다' },
      { status: 500 }
    );
  }
}
