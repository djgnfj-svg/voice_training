import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { evaluationService } from '@/services/evaluation.service';
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

    const body = await request.json();
    const { questionText, answerTranscript, interviewType, deepMode, relatedKeyPoints } = schema.parse(body);

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
