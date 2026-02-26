import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { anthropic, MODELS } from '@/lib/openai';
import { prisma } from '@/lib/prisma';
import { questionService } from '@/services/question.service';
import {
  MODEL_ANSWER_RESUME_PROMPT,
  MODEL_ANSWER_WITH_JOB_PROMPT,
} from '@/prompts/model-answer';

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: '로그인이 필요합니다' }, { status: 401 });
  }

  const body = await request.json();
  const { resumeId, jobPostingText } = body as {
    resumeId: string;
    jobPostingText?: string;
  };

  if (!resumeId) {
    return NextResponse.json({ error: 'resumeId는 필수입니다' }, { status: 400 });
  }

  const resume = await prisma.resume.findFirst({
    where: { id: resumeId, userId: session.user.id },
  });

  if (!resume) {
    return NextResponse.json({ error: '이력서를 찾을 수 없습니다' }, { status: 404 });
  }

  const parsedResume =
    typeof resume.parsedData === 'string'
      ? resume.parsedData
      : JSON.stringify(resume.parsedData, null, 2);

  try {
    // Step 1: Plan interview using existing service
    const plan = await questionService.planInterview({
      resumeId,
      userId: session.user.id,
    });

    // Step 2: Generate questions + model answers
    const promptTemplate = jobPostingText
      ? MODEL_ANSWER_WITH_JOB_PROMPT
      : MODEL_ANSWER_RESUME_PROMPT;

    let prompt = promptTemplate
      .replace('{interviewType}', plan.type)
      .replace('{categories}', plan.categories.join(', '))
      .replace('{difficulty}', plan.difficulty)
      .replace('{totalQuestions}', plan.totalQuestions.toString())
      .replace('{parsedResume}', parsedResume);

    if (jobPostingText) {
      prompt = prompt.replace('{jobPostingText}', jobPostingText);
    }

    const response = await anthropic.messages.create({
      model: MODELS.QUESTION_GEN,
      max_tokens: 8192,
      temperature: 0.7,
      system: 'You must respond with valid JSON only. No markdown, no explanation, just JSON.',
      messages: [{ role: 'user', content: prompt }],
    });

    const textBlock = response.content.find((b) => b.type === 'text');
    let content = textBlock ? textBlock.text : null;

    if (!content) {
      return NextResponse.json({ error: '질문 생성에 실패했습니다' }, { status: 500 });
    }

    // Strip markdown code blocks if present
    content = content.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();

    const parsed = JSON.parse(content);
    const questions = parsed.questions || [];

    return NextResponse.json({ plan, questions });
  } catch (error) {
    console.error('Model answer generation error:', error);
    return NextResponse.json(
      { error: '모범답안 생성 중 오류가 발생했습니다' },
      { status: 500 }
    );
  }
}
