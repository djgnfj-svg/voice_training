import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { evaluationService } from '@/services/evaluation.service';
import { z } from 'zod';

const evaluateSchema = z.object({
  sessionId: z.string(),
  questionIndex: z.number(),
  answerTranscript: z.string(),
  responseTimeSec: z.number().optional(),
});

export async function POST(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: '로그인이 필요합니다' }, { status: 401 });
    }

    const body = await request.json();
    const params = evaluateSchema.parse(body);

    const evaluation = await evaluationService.evaluateAnswer(params);
    return NextResponse.json(evaluation);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.errors[0].message }, { status: 400 });
    }
    console.error('Evaluation error:', error);
    return NextResponse.json({ error: '답변 평가에 실패했습니다' }, { status: 500 });
  }
}
