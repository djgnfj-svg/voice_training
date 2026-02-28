import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { checkRateLimit } from '@/lib/rate-limit';
import { resumeService } from '@/services/resume.service';
import type { ParsedResume } from '@/types';

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

    const formData = await request.formData();
    const file = formData.get('file') as File;
    if (!file) {
      return NextResponse.json({ error: '파일을 업로드해주세요' }, { status: 400 });
    }

    if (!file.name.endsWith('.pdf')) {
      return NextResponse.json({ error: 'PDF 파일만 업로드 가능합니다' }, { status: 400 });
    }

    const name = file.name.replace('.pdf', '');
    const buffer = Buffer.from(await file.arrayBuffer());
    const resume = await resumeService.uploadAndParse(session.user.id, buffer, file.name, name);

    return NextResponse.json(resume);
  } catch (error) {
    console.error('Resume upload error:', error);
    return NextResponse.json({ error: '이력서 업로드에 실패했습니다' }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: '로그인이 필요합니다' }, { status: 401 });
    }

    const resumes = await resumeService.getUserResumes(session.user.id);

    // Map to include skills from parsedData
    const items = resumes.map((r) => {
      const parsed = r.parsedData as unknown as ParsedResume | null;
      return {
        id: r.id,
        name: r.name,
        skills: parsed?.skills || [],
        createdAt: r.createdAt,
      };
    });

    return NextResponse.json(items);
  } catch (error) {
    console.error('Resume fetch error:', error);
    return NextResponse.json({ error: '이력서 조회에 실패했습니다' }, { status: 500 });
  }
}
