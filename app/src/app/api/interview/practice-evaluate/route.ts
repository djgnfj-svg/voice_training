import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { checkRateLimit } from '@/lib/rate-limit';
import { evaluationService } from '@/services/evaluation.service';
import { creditService, CREDIT_COSTS } from '@/services/credit.service';
import { z } from 'zod';
import type { InterviewType } from '@/types';

const schema = z.object({
  questionText: z.string().min(1),
  answerTranscript: z.string().min(1),
  interviewType: z.enum(['TECHNICAL', 'BEHAVIORAL', 'MIXED']),
  deepMode: z.boolean().optional(),
  relatedKeyPoints: z.array(z.string()).optional(),
});

export async function POST(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: '로그인이 필요합니다' }, { status: 401 });
    }

    const rateLimit = await checkRateLimit(session.user.id, 'ai-light');
    if (!rateLimit.success) {
      return NextResponse.json(
        { error: '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.' },
        { status: 429, headers: { 'Retry-After': String(rateLimit.resetAt - Math.floor(Date.now() / 1000)) } },
      );
    }

    const body = await request.json();
    const { questionText, answerTranscript, interviewType, deepMode, relatedKeyPoints } = schema.parse(body);

    // 꼬리질문 크레딧 차감
    try {
      await creditService.deductForFeature(session.user.id, 'follow-up', '꼬리질문 평가', CREDIT_COSTS.FOLLOW_UP);
    } catch {
      return NextResponse.json(
        { error: '크레딧이 부족합니다.', code: 'INSUFFICIENT_CREDITS' },
        { status: 402 },
      );
    }

    const evaluation = await evaluationService.evaluateStateless({
      questionText,
      answerTranscript,
      interviewType: interviewType as InterviewType,
      deepMode,
      relatedKeyPoints,
    });

    return NextResponse.json(evaluation);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.errors[0].message }, { status: 400 });
    }
    console.error('Practice evaluation error:', error);
    return NextResponse.json({ error: '평가에 실패했습니다' }, { status: 500 });
  }
}
