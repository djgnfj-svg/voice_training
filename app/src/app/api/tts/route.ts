import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { z } from 'zod';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ttsSchema = z.object({
  text: z.string().min(1).max(4096),
});

/** 괄호(소·중·대) 및 그 안의 내용을 제거 */
function stripParentheses(text: string): string {
  return text
    .replace(/\([^)]*\)/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\{[^}]*\}/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function POST(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: '로그인이 필요합니다' }, { status: 401 });
    }

    const body = await req.json();
    const { text } = ttsSchema.parse(body);

    const spokenText = stripParentheses(text);
    if (!spokenText) {
      return NextResponse.json({ error: 'No speakable text' }, { status: 400 });
    }

    const { MsEdgeTTS, OUTPUT_FORMAT } = await import('msedge-tts');
    const tts = new MsEdgeTTS();
    await tts.setMetadata(
      'ko-KR-HyunsuNeural',
      OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3
    );

    const { audioStream } = tts.toStream(spokenText);

    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(resolve, 15000);
      audioStream.on('data', (chunk: Buffer) => chunks.push(chunk));
      audioStream.on('end', () => {
        clearTimeout(timeout);
        resolve();
      });
      audioStream.on('error', (err: Error) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    const buffer = Buffer.concat(chunks);

    return new NextResponse(buffer, {
      headers: {
        'Content-Type': 'audio/mpeg',
        'Content-Length': buffer.length.toString(),
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    }
    console.error('TTS error:', error);
    return NextResponse.json({ error: 'TTS generation failed' }, { status: 500 });
  }
}
