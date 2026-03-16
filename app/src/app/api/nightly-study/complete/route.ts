import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { checkRateLimit } from '@/lib/rate-limit';
import { prisma } from '@/lib/prisma';
import { openai, MODELS } from '@/lib/openai';
import { NIGHTLY_STUDY_SUMMARY_PROMPT } from '@/prompts/nightly-study';
import { z } from 'zod';

const completeSchema = z.object({
  questions: z.array(z.object({
    originalQuestion: z.string(),
    tutorQuestion: z.string(),
    category: z.string(),
    subcategory: z.string(),
    conversation: z.array(z.object({
      role: z.enum(['tutor', 'user']),
      content: z.string(),
    })),
    conceptsCovered: z.array(z.string()),
    keyPoints: z.array(z.string()),
  })),
  mode: z.enum(['deep', 'light']),
  resumeId: z.string().optional(),
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
    const { questions, mode, resumeId } = completeSchema.parse(body);

    // Build session data for summary
    const sessionData = questions.map((q) => ({
      question: q.originalQuestion,
      category: q.category,
      conversationLength: q.conversation.length,
      conceptsCovered: q.conceptsCovered,
      keyPoints: q.keyPoints,
      conversation: q.conversation.map((c) =>
        `${c.role === 'tutor' ? '튜터' : '학생'}: ${c.content}`
      ).join('\n'),
    }));

    const prompt = NIGHTLY_STUDY_SUMMARY_PROMPT
      .replace('{sessionData}', JSON.stringify(sessionData, null, 2));

    const response = await openai.chat.completions.create({
      model: MODELS.ANALYSIS,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0.5,
    });

    const content = response.choices[0]?.message?.content;
    const fallbackSummary = { strengths: [], reviewTopics: [], encouragement: '오늘도 수고했어요!' };
    let summary;
    try {
      summary = content ? JSON.parse(content) : fallbackSummary;
    } catch {
      summary = fallbackSummary;
    }

    // Save ActivityLog + ActivityItems (no credit deduction)
    await prisma.activityLog.create({
      data: {
        userId: session.user.id,
        type: 'NIGHTLY_STUDY',
        resumeId: resumeId || null,
        metadata: { mode, summary },
        items: {
          create: questions.map((q, idx) => ({
            index: idx,
            question: q.originalQuestion,
            answer: q.conversation
              .filter((c) => c.role === 'user')
              .map((c) => c.content)
              .join('\n'),
            extra: {
              category: q.category,
              subcategory: q.subcategory,
              conceptsCovered: q.conceptsCovered,
              conversationLength: q.conversation.length,
            },
          })),
        },
      },
    });

    return NextResponse.json({ summary });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.errors[0].message }, { status: 400 });
    }
    console.error('Nightly study complete error:', error);
    return NextResponse.json({ error: '학습 완료 처리에 실패했습니다' }, { status: 500 });
  }
}
