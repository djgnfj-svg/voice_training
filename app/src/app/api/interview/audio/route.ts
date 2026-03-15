import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { writeFile, mkdir, readFile } from 'fs/promises';
import path from 'path';

const ALLOWED_EXTENSIONS = new Set(['webm', 'mp3', 'wav', 'ogg']);
const ALLOWED_MIME_TYPES = new Set([
  'audio/webm',
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/ogg',
  'audio/x-wav',
  'audio/wave',
]);
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

function getAudioStorageDir() {
  return path.join(process.cwd(), '.audio-storage');
}

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
    if (isNaN(qIndex) || qIndex < 0) {
      return NextResponse.json({ error: '잘못된 questionIndex' }, { status: 400 });
    }

    // Validate sessionId is UUID format to prevent path traversal
    const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_REGEX.test(sessionId)) {
      return NextResponse.json({ error: '잘못된 세션 ID' }, { status: 400 });
    }

    // File size validation
    if (audio.size > MAX_FILE_SIZE) {
      return NextResponse.json({ error: '파일 크기가 10MB를 초과합니다' }, { status: 400 });
    }

    // Extension validation
    const ext = (audio.name?.split('.').pop() || '').toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      return NextResponse.json({ error: '허용되지 않는 파일 형식입니다' }, { status: 400 });
    }

    // MIME type validation
    if (!ALLOWED_MIME_TYPES.has(audio.type)) {
      return NextResponse.json({ error: '허용되지 않는 MIME 타입입니다' }, { status: 400 });
    }

    // Verify session ownership
    const interviewSession = await prisma.interviewSession.findUnique({
      where: { id: sessionId, userId: session.user.id },
    });

    if (!interviewSession) {
      return NextResponse.json({ error: '세션을 찾을 수 없습니다' }, { status: 404 });
    }

    // Save to non-public directory
    const audioDir = path.join(getAudioStorageDir(), sessionId);
    await mkdir(audioDir, { recursive: true });

    const fileName = `${qIndex}.${ext}`;
    const filePath = path.join(audioDir, fileName);

    const buffer = Buffer.from(await audio.arrayBuffer());
    await writeFile(filePath, buffer);

    const audioUrl = `/api/interview/audio?sessionId=${sessionId}&questionIndex=${qIndex}`;

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

export async function GET(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: '로그인이 필요합니다' }, { status: 401 });
    }

    const searchParams = request.nextUrl.searchParams;
    const sessionId = searchParams.get('sessionId');
    const questionIndex = searchParams.get('questionIndex');

    if (!sessionId || questionIndex === null) {
      return NextResponse.json({ error: '필수 파라미터가 누락되었습니다' }, { status: 400 });
    }

    const qIndex = parseInt(questionIndex, 10);
    if (isNaN(qIndex) || qIndex < 0) {
      return NextResponse.json({ error: '잘못된 questionIndex' }, { status: 400 });
    }

    // Validate sessionId is UUID format to prevent path traversal
    const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_REGEX.test(sessionId)) {
      return NextResponse.json({ error: '잘못된 세션 ID' }, { status: 400 });
    }

    // Verify session ownership
    const interviewSession = await prisma.interviewSession.findUnique({
      where: { id: sessionId, userId: session.user.id },
    });

    if (!interviewSession) {
      return NextResponse.json({ error: '세션을 찾을 수 없습니다' }, { status: 404 });
    }

    // Find the audio file
    const audioDir = path.join(getAudioStorageDir(), sessionId);
    const possibleExts = ['webm', 'mp3', 'wav', 'ogg'];
    let fileBuffer: Buffer | null = null;
    let contentType = 'audio/webm';

    for (const ext of possibleExts) {
      const filePath = path.join(audioDir, `${qIndex}.${ext}`);
      try {
        fileBuffer = await readFile(filePath);
        const mimeMap: Record<string, string> = {
          webm: 'audio/webm',
          mp3: 'audio/mpeg',
          wav: 'audio/wav',
          ogg: 'audio/ogg',
        };
        contentType = mimeMap[ext] || 'audio/webm';
        break;
      } catch {
        continue;
      }
    }

    if (!fileBuffer) {
      return NextResponse.json({ error: '오디오 파일을 찾을 수 없습니다' }, { status: 404 });
    }

    return new NextResponse(new Uint8Array(fileBuffer), {
      headers: {
        'Content-Type': contentType,
        'Content-Length': fileBuffer.length.toString(),
        'Cache-Control': 'private, max-age=3600',
      },
    });
  } catch (error) {
    console.error('Audio serve error:', error);
    return NextResponse.json({ error: '오디오 파일 제공에 실패했습니다' }, { status: 500 });
  }
}
