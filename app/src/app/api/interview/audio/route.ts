import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { writeFile, mkdir } from 'fs/promises';
import path from 'path';

export async function POST(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: '로그인이 필요합니다' }, { status: 401 });
    }

    const formData = await request.formData();
    const audio = formData.get('audio') as File | null;
    const sessionId = formData.get('sessionId') as string | null;
    const questionIndex = formData.get('questionIndex') as string | null;

    if (!audio || !sessionId || questionIndex === null) {
      return NextResponse.json({ error: '필수 필드가 누락되었습니다' }, { status: 400 });
    }

    const qIndex = parseInt(questionIndex, 10);
    if (isNaN(qIndex)) {
      return NextResponse.json({ error: '잘못된 questionIndex' }, { status: 400 });
    }

    // Verify session ownership
    const interviewSession = await prisma.interviewSession.findUnique({
      where: { id: sessionId, userId: session.user.id },
    });

    if (!interviewSession) {
      return NextResponse.json({ error: '세션을 찾을 수 없습니다' }, { status: 404 });
    }

    // Save audio file
    const audioDir = path.join(process.cwd(), 'public', 'audio', sessionId);
    await mkdir(audioDir, { recursive: true });

    const ext = audio.name?.split('.').pop() || 'webm';
    const fileName = `${qIndex}.${ext}`;
    const filePath = path.join(audioDir, fileName);

    const buffer = Buffer.from(await audio.arrayBuffer());
    await writeFile(filePath, buffer);

    const audioUrl = `/audio/${sessionId}/${fileName}`;

    // Update InterviewAnswer with audioUrl
    await prisma.interviewAnswer.updateMany({
      where: {
        sessionId,
        questionIndex: qIndex,
      },
      data: { audioUrl },
    });

    return NextResponse.json({ audioUrl });
  } catch (error) {
    console.error('Audio upload error:', error);
    return NextResponse.json({ error: '오디오 업로드에 실패했습니다' }, { status: 500 });
  }
}
