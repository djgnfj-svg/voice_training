import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { reportService } from '@/services/report.service';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: '로그인이 필요합니다' }, { status: 401 });
    }

    const { id } = await params;

    // Update session status
    await prisma.interviewSession.update({
      where: { id, userId: session.user.id },
      data: { status: 'COMPLETED' },
    });

    // Generate report
    const report = await reportService.generateReport(id);
    return NextResponse.json(report);
  } catch (error) {
    console.error('Session complete error:', error);
    return NextResponse.json({ error: '면접 완료 처리에 실패했습니다' }, { status: 500 });
  }
}
