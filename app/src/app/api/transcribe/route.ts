import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { checkRateLimit } from '@/lib/rate-limit';
import { isWhisperAvailable, transcribeAudio } from '@/lib/whisper';

export const maxDuration = 30;

const MAX_FILE_SIZE = 4.5 * 1024 * 1024; // 4.5MB

export async function POST(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: '로그인이 필요합니다' }, { status: 401 });
    }

    const rateLimit = await checkRateLimit(session.user.id, 'ai-light');
    if (!rateLimit.success) {
      return NextResponse.json(
        { error: '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.' },
        { status: 429, headers: { 'Retry-After': String(rateLimit.resetAt - Math.floor(Date.now() / 1000)) } },
      );
    }

    if (!isWhisperAvailable) {
      return NextResponse.json({ error: 'Whisper API가 설정되지 않았습니다' }, { status: 503 });
    }

    const formData = await request.formData();
    const audioFile = formData.get('audio') as File | null;

    if (!audioFile) {
      return NextResponse.json({ error: '오디오 파일이 필요합니다' }, { status: 400 });
    }

    if (audioFile.size > MAX_FILE_SIZE) {
      return NextResponse.json({ error: '오디오 파일이 너무 큽니다' }, { status: 413 });
    }

    const transcript = await transcribeAudio(audioFile);

    if (!transcript) {
      return NextResponse.json({ error: '전사에 실패했습니다' }, { status: 500 });
    }

    return NextResponse.json({ transcript, source: 'whisper' });
  } catch (error) {
    console.error('Transcribe error:', error);
    return NextResponse.json({ error: '전사에 실패했습니다' }, { status: 500 });
  }
}
