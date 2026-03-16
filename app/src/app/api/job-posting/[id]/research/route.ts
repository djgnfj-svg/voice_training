import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { checkRateLimit } from '@/lib/rate-limit';
import { isTavilyAvailable } from '@/lib/tavily';
import { jobPostingService } from '@/services/job-posting.service';
import { creditService, CREDIT_COSTS } from '@/services/credit.service';
import type { CompanyAnalysis, ParsedJobPosting } from '@/types';
import { captureError } from '@/lib/error';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: '로그인이 필요합니다' }, { status: 401 });
    }

    if (!isTavilyAvailable) {
      return NextResponse.json({ error: '심층 분석 기능을 사용할 수 없습니다' }, { status: 503 });
    }

    const rateLimit = await checkRateLimit(session.user.id, 'ai-heavy');
    if (!rateLimit.success) {
      return NextResponse.json(
        { error: '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.' },
        { status: 429, headers: { 'Retry-After': String(rateLimit.resetAt - Math.floor(Date.now() / 1000)) } },
      );
    }

    const { id } = await params;

    const jobPosting = await prisma.jobPosting.findUnique({ where: { id } });
    if (!jobPosting || jobPosting.userId !== session.user.id) {
      return NextResponse.json({ error: '채용 공고를 찾을 수 없습니다' }, { status: 404 });
    }

    const existingAnalysis = jobPosting.companyAnalysis as CompanyAnalysis | null;
    if (existingAnalysis?.deepResearch) {
      return NextResponse.json({ companyAnalysis: existingAnalysis });
    }

    const isDev = process.env.NODE_ENV === 'development';
    if (!isDev) {
      const balance = await creditService.getBalance(session.user.id);
      if (balance < CREDIT_COSTS.DEEP_RESEARCH) {
        return NextResponse.json(
          { error: '크레딧이 부족합니다', code: 'INSUFFICIENT_CREDITS' },
          { status: 402 },
        );
      }
    }

    const parsedData = jobPosting.parsedData as ParsedJobPosting | null;
    if (!parsedData?.company) {
      return NextResponse.json({ error: '채용 공고 분석 데이터가 없습니다' }, { status: 400 });
    }

    const deepResult = await jobPostingService.deepCompanyResearch(
      parsedData.company,
      parsedData.position,
      parsedData.techStack,
    );

    const mergedAnalysis: CompanyAnalysis = {
      ...(existingAnalysis || { interviewStyle: '', culture: [], pastQuestionTrends: [] }),
      ...deepResult,
      interviewStyle: deepResult.interviewStyle || existingAnalysis?.interviewStyle || '',
      culture: deepResult.culture?.length ? deepResult.culture : (existingAnalysis?.culture || []),
      pastQuestionTrends: deepResult.pastQuestionTrends?.length ? deepResult.pastQuestionTrends : (existingAnalysis?.pastQuestionTrends || []),
      deepResearch: true,
    };

    // 크레딧 차감과 DB 저장을 트랜잭션으로 묶어 원자성 보장
    if (!isDev) {
      await prisma.$transaction(async (tx) => {
        const updated = await tx.user.updateMany({
          where: { id: session.user.id, creditBalance: { gte: CREDIT_COSTS.DEEP_RESEARCH } },
          data: { creditBalance: { decrement: CREDIT_COSTS.DEEP_RESEARCH } },
        });
        if (updated.count === 0) throw new Error('INSUFFICIENT_CREDITS');

        const user = await tx.user.findUnique({
          where: { id: session.user.id },
          select: { creditBalance: true },
        });

        await tx.creditTransaction.create({
          data: {
            userId: session.user.id,
            amount: -CREDIT_COSTS.DEEP_RESEARCH,
            balance: user!.creditBalance,
            type: 'FEATURE_DEBIT',
            description: '심층 기업 분석',
            referenceId: id,
          },
        });

        await tx.jobPosting.update({
          where: { id },
          data: {
            companyAnalysis: mergedAnalysis as unknown as Prisma.InputJsonValue,
          },
        });
      });
    } else {
      await prisma.jobPosting.update({
        where: { id },
        data: {
          companyAnalysis: mergedAnalysis as unknown as Prisma.InputJsonValue,
        },
      });
    }

    return NextResponse.json({ companyAnalysis: mergedAnalysis });
  } catch (error) {
    captureError(error, { context: 'deep-company-research' });
    if (error instanceof Error && error.message === 'INSUFFICIENT_CREDITS') {
      return NextResponse.json(
        { error: '크레딧이 부족합니다', code: 'INSUFFICIENT_CREDITS' },
        { status: 402 },
      );
    }
    return NextResponse.json({ error: '심층 기업 분석에 실패했습니다' }, { status: 500 });
  }
}
