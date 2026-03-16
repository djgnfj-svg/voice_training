import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { checkRateLimit } from '@/lib/rate-limit';
import { jobPostingService } from '@/services/job-posting.service';
import { isTavilyAvailable } from '@/lib/tavily';
import { captureError } from '@/lib/error';
import { z } from 'zod';

const analyzeSchema = z.object({
  rawText: z.string().min(10, '채용 공고 텍스트를 입력해주세요'),
});

export async function POST(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: '로그인이 필요합니다' }, { status: 401 });
    }

    const rateLimit = await checkRateLimit(session.user.id, 'ai-heavy');
    if (!rateLimit.success) {
      return NextResponse.json(
        { error: '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.' },
        { status: 429, headers: { 'Retry-After': String(rateLimit.resetAt - Math.floor(Date.now() / 1000)) } },
      );
    }

    const body = await request.json();
    const { rawText } = analyzeSchema.parse(body);

    const result = await jobPostingService.analyzeJobPosting(session.user.id, rawText);
    return NextResponse.json({ ...result, deepResearchAvailable: isTavilyAvailable });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.errors[0].message }, { status: 400 });
    }
    captureError(error, { context: 'job-posting-analysis' });
    return NextResponse.json({ error: '채용 공고 분석에 실패했습니다' }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: '로그인이 필요합니다' }, { status: 401 });
    }

    const postings = await jobPostingService.getUserJobPostings(session.user.id);
    return NextResponse.json(postings);
  } catch (error) {
    captureError(error, { context: 'job-posting-fetch' });
    return NextResponse.json({ error: '채용 공고 조회에 실패했습니다' }, { status: 500 });
  }
}
