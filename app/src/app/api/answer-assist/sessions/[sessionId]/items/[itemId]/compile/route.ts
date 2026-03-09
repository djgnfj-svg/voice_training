import { NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { isAdmin } from '@/lib/admin';
import { prisma } from '@/lib/prisma';
import { anthropic, MODELS } from '@/lib/openai';
import { buildAnswerAssistCompilePrompt } from '@/prompts/answer-assist';

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ sessionId: string; itemId: string }> }
) {
  const session = await auth();
  if (!session?.user?.id || !isAdmin(session.user.email)) {
    return new Response(JSON.stringify({ error: '권한이 없습니다' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { sessionId, itemId } = await params;

  const assistSession = await prisma.answerAssistSession.findFirst({
    where: { id: sessionId, userId: session.user.id },
    include: { resume: { select: { parsedData: true } } },
  });

  if (!assistSession) {
    return new Response(JSON.stringify({ error: '세션을 찾을 수 없습니다' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const item = await prisma.answerAssistItem.findFirst({
    where: { id: itemId, sessionId },
  });

  if (!item) {
    return new Response(JSON.stringify({ error: '항목을 찾을 수 없습니다' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const conversation = item.conversation as { role: string; content: string }[];
  if (conversation.length === 0) {
    return new Response(JSON.stringify({ error: '대화 내용이 없습니다' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const parsedResume =
    typeof assistSession.resume.parsedData === 'string'
      ? assistSession.resume.parsedData
      : JSON.stringify(assistSession.resume.parsedData, null, 2);

  const { system, user } = buildAnswerAssistCompilePrompt({
    parsedResume,
    questionText: item.questionText,
    conversation,
  });

  const stream = anthropic.messages.stream({
    model: MODELS.ANALYSIS,
    max_tokens: 2048,
    temperature: 0.5,
    system,
    messages: [{ role: 'user', content: user }],
  });

  const encoder = new TextEncoder();
  let accumulated = '';

  const readable = new ReadableStream({
    async start(controller) {
      try {
        for await (const event of stream) {
          if (
            event.type === 'content_block_delta' &&
            event.delta.type === 'text_delta'
          ) {
            accumulated += event.delta.text;
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ text: event.delta.text })}\n\n`)
            );
          }
        }

        await prisma.answerAssistItem.update({
          where: { id: itemId },
          data: {
            finalAnswer: accumulated,
            isCompleted: true,
          },
        });

        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      } catch (error) {
        console.error('Answer assist compile streaming error:', error);
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ error: '최종 답변 정리 중 오류가 발생했습니다' })}\n\n`)
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
