import { NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { checkRateLimit } from '@/lib/rate-limit';
import { anthropic, MODELS } from '@/lib/openai';
import { prisma } from '@/lib/prisma';
import { creditService } from '@/services/credit.service';
import { buildCunningSuggestPrompt } from '@/prompts/cunning';

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return new Response(JSON.stringify({ error: '로그인이 필요합니다' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const rateLimit = await checkRateLimit(session.user.id, 'ai-light');
  if (!rateLimit.success) {
    return new Response(JSON.stringify({ error: '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.' }), {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': String(rateLimit.resetAt - Math.floor(Date.now() / 1000)),
      },
    });
  }

  const body = await request.json();
  const { resumeId, question, jobPostingText, conversationHistory, cunningSessionId } = body as {
    resumeId: string;
    question: string;
    jobPostingText?: string;
    conversationHistory?: { question: string; answer: string }[];
    cunningSessionId?: string;
  };

  if (!resumeId || !question) {
    return new Response(JSON.stringify({ error: 'resumeId와 question은 필수입니다' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const resume = await prisma.resume.findFirst({
    where: { id: resumeId, userId: session.user.id },
    select: { parsedData: true },
  });

  if (!resume) {
    return new Response(JSON.stringify({ error: '이력서를 찾을 수 없습니다' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Credit check: only charge on first call of a cunning session
  if (cunningSessionId) {
    const existing = await prisma.creditTransaction.findFirst({
      where: { userId: session.user.id, referenceId: cunningSessionId },
    });
    if (!existing) {
      const creditCheck = await creditService.canStartSession(session.user.id);
      if (!creditCheck.allowed) {
        return new Response(
          JSON.stringify({ error: '크레딧이 부족합니다. 크레딧을 충전해주세요.', code: 'INSUFFICIENT_CREDITS' }),
          { status: 402, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (creditCheck.usingFreeTrial) {
        await prisma.$transaction([
          prisma.user.update({ where: { id: session.user.id }, data: { freeTrialUsed: true } }),
          prisma.creditTransaction.create({
            data: {
              userId: session.user.id,
              amount: 0,
              balance: 0,
              type: 'FREE_TRIAL',
              description: '컨닝 모드 무료 체험',
              referenceId: cunningSessionId,
            },
          }),
        ]);
      } else {
        await creditService.deductForFeature(session.user.id, cunningSessionId, '컨닝 모드 사용');
      }
    }
  }

  const parsedResume =
    typeof resume.parsedData === 'string'
      ? resume.parsedData
      : JSON.stringify(resume.parsedData, null, 2);

  const { system, user } = buildCunningSuggestPrompt({
    parsedResume,
    question,
    jobPostingText,
    conversationHistory,
  });

  const stream = anthropic.messages.stream({
    model: MODELS.ANALYSIS,
    max_tokens: 512,
    temperature: 0.7,
    system,
    messages: [{ role: 'user', content: user }],
  });

  const encoder = new TextEncoder();

  const readable = new ReadableStream({
    async start(controller) {
      try {
        for await (const event of stream) {
          if (
            event.type === 'content_block_delta' &&
            event.delta.type === 'text_delta'
          ) {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ text: event.delta.text })}\n\n`)
            );
          }
        }
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      } catch (error) {
        console.error('Cunning suggest streaming error:', error);
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ error: '답변 생성 중 오류가 발생했습니다' })}\n\n`)
        );
        controller.close();
      }
    },
  });

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
