import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { jobPostingService } from '@/services/job-posting.service';
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

    const body = await request.json();
    const { rawText } = analyzeSchema.parse(body);

    const result = await jobPostingService.analyzeJobPosting(session.user.id, rawText);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.errors[0].message }, { status: 400 });
    }
    console.error('Job posting analysis error:', error);
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
    console.error('Job posting fetch error:', error);
    return NextResponse.json({ error: '채용 공고 조회에 실패했습니다' }, { status: 500 });
  }
}
