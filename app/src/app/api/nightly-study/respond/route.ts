import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { checkRateLimit } from '@/lib/rate-limit';
import { openai, MODELS } from '@/lib/openai';
import { NIGHTLY_TUTOR_RESPONSE_PROMPT } from '@/prompts/nightly-study';
import { z } from 'zod';

const respondSchema = z.object({
  questionText: z.string(),
  userAnswer: z.string(),
  conversationHistory: z.array(z.object({
    role: z.enum(['tutor', 'user']),
    content: z.string(),
  })),
  mode: z.enum(['deep', 'light']),
  round: z.number().int().min(1),
  keyPoints: z.array(z.string()),
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
        { status: 429 },
      );
    }

    const body = await request.json();
    const { questionText, userAnswer, conversationHistory, mode, round, keyPoints } = respondSchema.parse(body);

    const maxRounds = mode === 'deep' ? 5 : 3;

    const historyStr = conversationHistory
      .map((h) => `${h.role === 'tutor' ? '튜터' : '학생'}: ${h.content}`)
      .join('\n');

    const prompt = NIGHTLY_TUTOR_RESPONSE_PROMPT
      .replace('{originalQuestion}', questionText)
      .replace('{keyPoints}', keyPoints.join(', '))
      .replace('{conversationHistory}', historyStr || '(첫 번째 답변)')
      .replace('{userAnswer}', userAnswer || '(답변 없음 — 잘 모르겠다고 함)')
      .replace('{round}', String(round))
      .replace('{maxRounds}', String(maxRounds));

    const response = await openai.chat.completions.create({
      model: MODELS.EVALUATION,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0.6,
      max_tokens: 1024,
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      return NextResponse.json({ error: 'AI 응답 생성에 실패했습니다' }, { status: 500 });
    }

    const parsed = JSON.parse(content);

    return NextResponse.json({
      tutorResponse: parsed.tutorResponse,
      followUpQuestion: parsed.followUpQuestion || null,
      isComplete: parsed.isComplete ?? (round >= maxRounds),
      conceptsCovered: parsed.conceptsCovered || [],
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.errors[0].message }, { status: 400 });
    }
    console.error('Nightly study respond error:', error);
    return NextResponse.json({ error: '튜터 응답 생성에 실패했습니다' }, { status: 500 });
  }
}
