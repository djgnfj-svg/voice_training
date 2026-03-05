import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { checkRateLimit } from '@/lib/rate-limit';
import { evaluationService } from '@/services/evaluation.service';
import { z } from 'zod';

const evaluateSchema = z.object({
  sessionId: z.string(),
  questionIndex: z.number(),
  answerTranscript: z.string(),
  responseTimeSec: z.number().optional(),
  deepMode: z.boolean().optional(),
  systemDesign: z.boolean().optional(),
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
    const { sessionId, questionIndex, answerTranscript, responseTimeSec, deepMode, systemDesign, relatedKeyPoints } = evaluateSchema.parse(body);

    const evaluation = await evaluationService.evaluateAnswer({
      sessionId,
      questionIndex,
      answerTranscript,
      responseTimeSec,
      deepMode,
      systemDesign,
      relatedKeyPoints,
    });
    return NextResponse.json(evaluation);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.errors[0].message }, { status: 400 });
    }
    console.error('Evaluation error:', error);
    return NextResponse.json({ error: '답변 평가에 실패했습니다' }, { status: 500 });
  }
}
