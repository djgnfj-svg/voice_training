import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { isAdmin } from '@/lib/admin';
import { prisma } from '@/lib/prisma';
import { openai, MODELS } from '@/lib/openai';
import { ANSWER_ASSIST_QUESTION_PROMPT } from '@/prompts/answer-assist';

export async function POST(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id || !isAdmin(session.user.email)) {
      return NextResponse.json({ error: '권한이 없습니다' }, { status: 403 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: '잘못된 요청입니다' }, { status: 400 });
    }
    const { resumeId } = body as { resumeId: string };
    if (!resumeId) {
      return NextResponse.json({ error: 'resumeId는 필수입니다' }, { status: 400 });
    }

    const resume = await prisma.resume.findFirst({
      where: { id: resumeId, userId: session.user.id },
      select: { parsedData: true, name: true },
    });

    if (!resume) {
      return NextResponse.json({ error: '이력서를 찾을 수 없습니다' }, { status: 404 });
    }

    const parsedResume =
      typeof resume.parsedData === 'string'
        ? resume.parsedData
        : JSON.stringify(resume.parsedData, null, 2);

    const result = await openai.chat.completions.create({
      model: MODELS.QUESTION_GEN,
      messages: [
        { role: 'system', content: ANSWER_ASSIST_QUESTION_PROMPT },
        { role: 'user', content: `이력서:\n${parsedResume}\n\n위 이력서를 분석하여 면접 질문을 생성하세요.` },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.7,
    });

    const content = result.choices[0]?.message?.content;
    if (!content) {
      return NextResponse.json({ error: '질문 생성에 실패했습니다' }, { status: 500 });
    }

    let questions: { text: string; category: string }[];
    try {
      const parsed = JSON.parse(content) as { questions: { text: string; category: string }[] };
      questions = parsed.questions;
    } catch {
      return NextResponse.json({ error: 'AI 응답 파싱에 실패했습니다' }, { status: 500 });
    }

    const assistSession = await prisma.answerAssistSession.create({
      data: {
        userId: session.user.id,
        resumeId,
        items: {
          create: questions.map((q, i) => ({
            questionIndex: i,
            questionText: q.text,
            conversation: [],
          })),
        },
      },
      include: { items: { orderBy: { questionIndex: 'asc' } } },
    });

    return NextResponse.json(assistSession);
  } catch (error) {
    console.error('Answer assist session creation error:', error);
    return NextResponse.json({ error: '세션 생성에 실패했습니다' }, { status: 500 });
  }
}

export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id || !isAdmin(session.user.email)) {
      return NextResponse.json({ error: '권한이 없습니다' }, { status: 403 });
    }

    const sessions = await prisma.answerAssistSession.findMany({
      where: { userId: session.user.id },
      orderBy: { createdAt: 'desc' },
      include: {
        resume: { select: { name: true } },
        items: { select: { id: true, isCompleted: true } },
      },
    });

    const result = sessions.map((s) => ({
      id: s.id,
      resumeName: s.resume.name,
      createdAt: s.createdAt,
      totalItems: s.items.length,
      completedItems: s.items.filter((i) => i.isCompleted).length,
    }));

    return NextResponse.json(result);
  } catch (error) {
    console.error('Answer assist sessions list error:', error);
    return NextResponse.json({ error: '세션 목록 조회에 실패했습니다' }, { status: 500 });
  }
}
