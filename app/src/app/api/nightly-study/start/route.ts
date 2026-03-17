import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { checkRateLimit } from '@/lib/rate-limit';
import { prisma } from '@/lib/prisma';
import { openai, MODELS } from '@/lib/openai';
import { NIGHTLY_TUTOR_QUESTION_PROMPT } from '@/prompts/nightly-study';
import { getKstMidnight } from '@/lib/date';
import { knowledgeService } from '@/services/knowledge.service';
import { captureError } from '@/lib/error';
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

function hashQuestion(q: string): string {
  let hash = 0;
  for (let i = 0; i < q.length; i++) {
    hash = ((hash << 5) - hash + q.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36).padStart(6, '0');
}

interface TopicMemory {
  askedQuestions?: string[];
  weakPoints?: string[];
  lastScore?: number;
  studyCount?: number;
}

/**
 * 학습 기억 기반 스마트 출제: 중복 방지 + 약점 우선 + 복습 스케줄
 */
async function pickSmartQuestions(
  userId: string,
  categories: string[],
  count: number,
): Promise<{ question: BankQuestion; category: string; learnerProfile: string }[]> {
  const pool: { question: BankQuestion; category: string }[] = [];
  for (const cat of categories) {
    const bank = CATEGORY_MAP[cat];
    if (!bank) continue;
    for (const q of bank.questions) {
      pool.push({ question: q, category: cat });
    }
  }
  if (pool.length === 0) return [];

  // 과거 출제 질문 해시 수집 (ActivityItem에서)
  const pastItems = await prisma.activityItem.findMany({
    where: { activityLog: { userId, type: 'NIGHTLY_STUDY' } },
    select: { question: true },
  });
  const askedSet = new Set(pastItems.map(i => hashQuestion(i.question)));

  // 사용자 지식 조회
  const knowledge = await knowledgeService.getUserKnowledge(userId);

  // topic name → knowledge 맵 (다양한 키로 매핑)
  const knowledgeMap = new Map<string, { proficiency: number; nextReviewAt: Date | null; metadata: TopicMemory | null }>();
  for (const k of knowledge) {
    const meta = k.metadata as TopicMemory | null;
    const entry = { proficiency: k.proficiency, nextReviewAt: k.nextReviewAt, metadata: meta };
    knowledgeMap.set(k.topic.name.toLowerCase(), entry);
  }

  // 각 문제 점수 매기기
  const now = new Date();
  const scored = pool.map((item) => {
    const qHash = hashQuestion(item.question.questionText);
    const isAsked = askedSet.has(qHash);

    // subcategory로 knowledge 찾기 (다단계)
    const sub = item.question.subcategory.toLowerCase();
    let kEntry = knowledgeMap.get(sub);
    if (!kEntry) {
      // subcategory를 포함하는 토픽 찾기
      for (const [name, entry] of knowledgeMap) {
        if (name.includes(sub) || sub.includes(name.split(/\s/)[0])) {
          kEntry = entry;
          break;
        }
      }
    }

    let priority: number;
    if (!kEntry) {
      priority = 50; // 미학습 토픽 → 중간
    } else {
      const isDue = kEntry.nextReviewAt && kEntry.nextReviewAt <= now;
      const hasWeakPoints = (kEntry.metadata?.weakPoints?.length ?? 0) > 0;

      if (isDue) {
        priority = 10; // 복습 예정 → 최우선
      } else if (kEntry.proficiency < 40 && hasWeakPoints) {
        priority = 20; // 약점 + 구체적 약점 있음
      } else if (kEntry.proficiency < 60) {
        priority = 40; // 보통
      } else {
        priority = 70 + kEntry.proficiency * 0.3; // 강점 → 회피
      }
    }

    // 이미 출제된 질문은 우선순위 대폭 낮춤 (but 완전 제거는 아님)
    if (isAsked) priority += 200;

    const jitter = Math.random() * 15 - 7.5;
    return { ...item, score: priority + jitter, isAsked };
  });

  scored.sort((a, b) => a.score - b.score);

  // 학습자 프로필 생성 함수
  const buildProfile = (subcategory: string): string => {
    const sub = subcategory.toLowerCase();
    let kEntry: { proficiency: number; metadata: TopicMemory | null } | undefined;
    kEntry = knowledgeMap.get(sub);
    if (!kEntry) {
      for (const [name, entry] of knowledgeMap) {
        if (name.includes(sub) || sub.includes(name.split(/\s/)[0])) {
          kEntry = entry;
          break;
        }
      }
    }
    if (!kEntry) return '(이 주제는 처음 학습)';

    const parts: string[] = [];
    parts.push(`숙련도: ${kEntry.proficiency}/100`);
    parts.push(`학습 횟수: ${kEntry.metadata?.studyCount ?? 0}회`);
    if (kEntry.metadata?.weakPoints?.length) {
      parts.push(`약점: ${kEntry.metadata.weakPoints.slice(0, 3).join(', ')}`);
    }
    return parts.join(' | ');
  };

  return scored.slice(0, count).map(s => ({
    question: s.question,
    category: s.category,
    learnerProfile: buildProfile(s.question.subcategory),
  }));
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

    // Pick questions based on mode (학습 기억 기반 스마트 출제, 실패 시 랜덤 폴백)
    const questionCount = mode === 'deep' ? 1 : 2;
    let picked: { question: BankQuestion; category: string; learnerProfile?: string }[];
    try {
      picked = await pickSmartQuestions(session.user.id, categories, questionCount);
    } catch {
      picked = pickRandomQuestions(categories, questionCount);
    }

    if (picked.length === 0) {
      return NextResponse.json({ error: '선택한 카테고리에 질문이 없습니다' }, { status: 400 });
    }

    // Generate conversational questions via AI
    const questions = await Promise.all(
      picked.map(async ({ question, category, learnerProfile }) => {
        const prompt = NIGHTLY_TUTOR_QUESTION_PROMPT
          .replace('{bankQuestion}', question.questionText)
          .replace('{keyPoints}', question.keyPoints.join(', '))
          .replace('{learnerProfile}', learnerProfile || '(첫 학습)');

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
    captureError(error, { context: 'nightly-study-start' });
    return NextResponse.json({ error: '학습 세션 시작에 실패했습니다' }, { status: 500 });
  }
}
