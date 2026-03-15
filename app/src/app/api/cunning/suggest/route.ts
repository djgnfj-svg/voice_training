import { NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { isAdmin } from '@/lib/admin';
import { anthropic, MODELS } from '@/lib/openai';
import { prisma } from '@/lib/prisma';
import { buildCunningSuggestPrompt } from '@/prompts/cunning';

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id || !isAdmin(session.user.email)) {
    return new Response(JSON.stringify({ error: '권한이 없습니다' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: '잘못된 요청입니다' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const { resumeId, question, jobPostingText, conversationHistory } = body as {
    resumeId: string;
    question: string;
    jobPostingText?: string;
    conversationHistory?: { question: string; answer: string }[];
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

  try {
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
  } catch (error) {
    console.error('Cunning suggest error:', error);
    return new Response(JSON.stringify({ error: '답변 생성 중 오류가 발생했습니다' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
