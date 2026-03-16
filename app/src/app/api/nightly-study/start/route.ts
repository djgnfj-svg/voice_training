import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { checkRateLimit } from '@/lib/rate-limit';
import { prisma } from '@/lib/prisma';
import { openai, MODELS } from '@/lib/openai';
import { NIGHTLY_TUTOR_QUESTION_PROMPT } from '@/prompts/nightly-study';
import { getKstMidnight } from '@/lib/date';
import { z } from 'zod';

import csBasics from '@/data/questions/cs-basics.json';
import javascript from '@/data/questions/javascript.json';
import react from '@/data/questions/react.json';
import nextjs from '@/data/questions/nextjs.json';
import typescriptAdvanced from '@/data/questions/typescript-advanced.json';
import databaseAdvanced from '@/data/questions/database-advanced.json';
import devops from '@/data/questions/devops.json';

interface BankQuestion {
  subcategory: string;
  difficulty: string;
  questionText: string;
  keyPoints: string[];
  deepDiveTopics?: string[];
}

interface QuestionBank {
  category: string;
  questions: BankQuestion[];
}

const CATEGORY_MAP: Record<string, QuestionBank> = {
  CS_BASICS: csBasics,
  JAVASCRIPT: javascript,
  REACT: react,
  NEXTJS: nextjs,
  TYPESCRIPT: typescriptAdvanced as QuestionBank,
  DATABASE: databaseAdvanced as QuestionBank,
  DEVOPS: devops as QuestionBank,
};

const VALID_CATEGORIES = ['CS_BASICS', 'JAVASCRIPT', 'REACT', 'NEXTJS', 'TYPESCRIPT', 'DATABASE', 'DEVOPS'] as const;

const startSchema = z.object({
  categories: z.array(z.enum(VALID_CATEGORIES)).min(1),
  mode: z.enum(['deep', 'light']),
  resumeId: z.string().optional(),
});

function pickRandomQuestions(categories: string[], count: number): { question: BankQuestion; category: string }[] {
  const pool: { question: BankQuestion; category: string }[] = [];

  for (const cat of categories) {
    const bank = CATEGORY_MAP[cat];
    if (!bank) continue;
    for (const q of bank.questions) {
      pool.push({ question: q, category: cat });
    }
  }

  // Shuffle and pick
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }

  return pool.slice(0, count);
}

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
    const { categories, mode, resumeId } = startSchema.parse(body);

    // Daily limit check (skip in dev)
    if (process.env.NODE_ENV !== 'development') {
      const kstMidnight = getKstMidnight();
      const todaySession = await prisma.activityLog.findFirst({
        where: {
          userId: session.user.id,
          type: 'NIGHTLY_STUDY',
          createdAt: { gte: kstMidnight },
        },
      });
      if (todaySession) {
        return NextResponse.json(
          { error: '오늘은 이미 학습을 완료했어요!', code: 'DAILY_LIMIT_REACHED' },
          { status: 429 },
        );
      }
    }

    // Pick questions based on mode
    const questionCount = mode === 'deep' ? 1 : 2;
    const picked = pickRandomQuestions(categories, questionCount);

    if (picked.length === 0) {
      return NextResponse.json({ error: '선택한 카테고리에 질문이 없습니다' }, { status: 400 });
    }

    // Generate conversational questions via AI
    const questions = await Promise.all(
      picked.map(async ({ question, category }) => {
        const prompt = NIGHTLY_TUTOR_QUESTION_PROMPT
          .replace('{bankQuestion}', question.questionText)
          .replace('{keyPoints}', question.keyPoints.join(', '));

        const response = await openai.chat.completions.create({
          model: MODELS.QUESTION_GEN,
          messages: [{ role: 'user', content: prompt }],
          response_format: { type: 'json_object' },
          temperature: 0.7,
          max_tokens: 512,
        });

        const content = response.choices[0]?.message?.content;
        let parsed: { tutorQuestion?: string };
        try {
          parsed = content ? JSON.parse(content) : { tutorQuestion: question.questionText };
        } catch {
          parsed = { tutorQuestion: question.questionText };
        }

        return {
          originalQuestion: question.questionText,
          tutorQuestion: parsed.tutorQuestion || question.questionText,
          keyPoints: question.keyPoints,
          category,
          subcategory: question.subcategory,
        };
      })
    );

    return NextResponse.json({ questions });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.errors[0].message }, { status: 400 });
    }
    console.error('Nightly study start error:', error);
    return NextResponse.json({ error: '학습 세션 시작에 실패했습니다' }, { status: 500 });
  }
}
