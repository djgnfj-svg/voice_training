import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { checkRateLimit } from '@/lib/rate-limit';
import { prisma } from '@/lib/prisma';
import { openai, MODELS } from '@/lib/openai';
import { NIGHTLY_STUDY_SUMMARY_PROMPT } from '@/prompts/nightly-study';
import { knowledgeService } from '@/services/knowledge.service';
import { dailyProgressService } from '@/services/daily-progress.service';
import { captureError } from '@/lib/error';
import { z } from 'zod';

function hashQuestion(q: string): string {
  let hash = 0;
  for (let i = 0; i < q.length; i++) {
    hash = ((hash << 5) - hash + q.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36).padStart(6, '0');
}

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
    understandingScore: z.number().min(0).max(100).optional().default(50),
    weakPoints: z.array(z.string()).optional().default([]),
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

    // 학습 기억 갱신
    try {
      for (const q of questions) {
        // subcategory → topic 매핑 (다단계 폴백)
        let topic = await prisma.topic.findFirst({
          where: { name: { equals: q.subcategory, mode: 'insensitive' } },
        });
        if (!topic) {
          topic = await prisma.topic.findFirst({
            where: { name: { contains: q.subcategory, mode: 'insensitive' } },
          });
        }
        if (!topic) {
          const firstWord = q.subcategory.split(/[\/\s]/)[0];
          if (firstWord && firstWord !== q.subcategory) {
            topic = await prisma.topic.findFirst({
              where: { subject: { name: { contains: firstWord, mode: 'insensitive' } } },
            });
          }
        }
        if (!topic && q.keyPoints.length > 0) {
          topic = await prisma.topic.findFirst({
            where: { keyPoints: { hasSome: q.keyPoints.slice(0, 3) } },
          });
        }
        if (!topic) continue;

        // 기존 metadata 읽기
        const existing = await prisma.userKnowledge.findUnique({
          where: { userId_topicId: { userId: session.user.id, topicId: topic.id } },
        });
        const prevMeta = (existing?.metadata as { askedQuestions?: string[]; weakPoints?: string[]; lastScore?: number; studyCount?: number } | null) ?? {
          askedQuestions: [],
          weakPoints: [],
          lastScore: 0,
          studyCount: 0,
        };

        // 질문 해시 (중복 출제 방지용)
        const qHash = hashQuestion(q.originalQuestion);

        // 약점 병합: 점수 높으면 이전 약점 제거, 아니면 누적
        const mergedWeakPoints = q.understandingScore >= 80
          ? (q.weakPoints || []).slice(0, 5)
          : [...new Set([...(prevMeta.weakPoints || []), ...(q.weakPoints || [])])].slice(-5);

        const newMeta = {
          askedQuestions: [...(prevMeta.askedQuestions || []), qHash].slice(-30),
          weakPoints: mergedWeakPoints,
          lastScore: q.understandingScore,
          studyCount: (prevMeta.studyCount || 0) + 1,
        };

        const wasCorrect = q.understandingScore >= 60;
        await knowledgeService.updateKnowledge(session.user.id, topic.id, wasCorrect, q.understandingScore, newMeta);
      }

      // 일일 진도 기록
      const topicsStudied = [...new Set(questions.map(q => q.subcategory))];
      await dailyProgressService.recordProgress(session.user.id, {
        subjectId: 'nightly-study',
        totalQuestions: questions.length,
        correctCount: questions.filter(q => q.understandingScore >= 60).length,
        durationSeconds: 0,
        topicsStudied,
      });
    } catch (knowledgeErr) {
      captureError(knowledgeErr, { context: 'nightly-study-knowledge-update' });
    }

    return NextResponse.json({ summary });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.errors[0].message }, { status: 400 });
    }
    captureError(error, { context: 'nightly-study-complete' });
    return NextResponse.json({ error: '학습 완료 처리에 실패했습니다' }, { status: 500 });
  }
}
