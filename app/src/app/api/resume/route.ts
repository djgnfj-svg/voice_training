import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { resumeService } from '@/services/resume.service';

export async function POST(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: '로그인이 필요합니다' }, { status: 401 });
    }

    const formData = await request.formData();
    const file = formData.get('file') as File;

    if (!file) {
      return NextResponse.json({ error: '파일을 업로드해주세요' }, { status: 400 });
    }

    if (!file.name.endsWith('.pdf')) {
      return NextResponse.json({ error: 'PDF 파일만 업로드 가능합니다' }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const result = await resumeService.uploadAndParse(session.user.id, buffer, file.name);

    return NextResponse.json(result);
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

    const resume = await resumeService.getUserResume(session.user.id);
    return NextResponse.json(resume);
  } catch (error) {
    console.error('Resume fetch error:', error);
    return NextResponse.json({ error: '이력서 조회에 실패했습니다' }, { status: 500 });
  }
}
