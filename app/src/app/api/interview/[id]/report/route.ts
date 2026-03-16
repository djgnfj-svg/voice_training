import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { reportService } from '@/services/report.service';
import { captureError } from '@/lib/error';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: '로그인이 필요합니다' }, { status: 401 });
    }

    const { id } = await params;

    // Check if report already exists
    const interviewSession = await prisma.interviewSession.findUnique({
      where: { id, userId: session.user.id },
    });

    if (!interviewSession) {
      return NextResponse.json({ error: '면접 세션을 찾을 수 없습니다' }, { status: 404 });
    }

    if (interviewSession.reportData) {
      return NextResponse.json(interviewSession.reportData);
    }

    // Generate report if not exists
    const report = await reportService.generateReport(id);
    return NextResponse.json(report);
  } catch (error) {
    captureError(error, { context: 'report-fetch' });
    return NextResponse.json({ error: '리포트 조회에 실패했습니다' }, { status: 500 });
  }
}
