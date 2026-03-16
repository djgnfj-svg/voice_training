import { NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { isAdmin } from '@/lib/admin';
import { prisma } from '@/lib/prisma';
import { anthropic, MODELS } from '@/lib/openai';
import { buildAnswerAssistFollowupPrompt } from '@/prompts/answer-assist';
import { captureError } from '@/lib/error';

export async function POST(
  request: NextRequest,
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

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: '잘못된 요청입니다' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const { message } = body as { message: string };

  if (!message?.trim()) {
    return new Response(JSON.stringify({ error: '메시지를 입력해주세요' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (message.length > 5000) {
    return new Response(JSON.stringify({ error: '메시지가 너무 깁니다 (최대 5000자)' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

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
  conversation.push({ role: 'user', content: message.trim() });

  await prisma.answerAssistItem.update({
    where: { id: itemId },
    data: { conversation },
  });

  const parsedResume =
    typeof assistSession.resume.parsedData === 'string'
      ? assistSession.resume.parsedData
      : JSON.stringify(assistSession.resume.parsedData, null, 2);

  const { system, user } = buildAnswerAssistFollowupPrompt({
    parsedResume,
    questionText: item.questionText,
    conversation,
  });

  const stream = anthropic.messages.stream({
    model: MODELS.ANALYSIS,
    max_tokens: 1024,
    temperature: 0.7,
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

        conversation.push({ role: 'ai', content: accumulated });
        await prisma.answerAssistItem.update({
          where: { id: itemId },
          data: { conversation },
        });

        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      } catch (error) {
        captureError(error, { context: 'answer-assist-chat-streaming' });
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ error: '응답 생성 중 오류가 발생했습니다' })}\n\n`)
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
