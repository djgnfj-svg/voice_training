import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { resumeService } from '@/services/resume.service';

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
    const resume = await resumeService.getResumeById(id, session.user.id);
    if (!resume) {
      return NextResponse.json({ error: '이력서를 찾을 수 없습니다' }, { status: 404 });
    }

    return NextResponse.json(resume);
  } catch {
    return NextResponse.json({ error: '이력서 조회에 실패했습니다' }, { status: 500 });
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: '로그인이 필요합니다' }, { status: 401 });
    }

    const { id } = await params;
    const body = await request.json();
    const { name } = body;

    if (!name || typeof name !== 'string') {
      return NextResponse.json({ error: '이름을 입력해주세요' }, { status: 400 });
    }

    const resume = await resumeService.renameResume(id, session.user.id, name);
    return NextResponse.json(resume);
  } catch (error: unknown) {
    if (error instanceof Error && error.message === 'Resume not found') {
      return NextResponse.json({ error: '이력서를 찾을 수 없습니다' }, { status: 404 });
    }
    return NextResponse.json({ error: '이름 변경에 실패했습니다' }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: '로그인이 필요합니다' }, { status: 401 });
    }

    const { id } = await params;
    await resumeService.deleteResume(id, session.user.id);
    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    if (error instanceof Error && error.message === 'Resume not found') {
      return NextResponse.json({ error: '이력서를 찾을 수 없습니다' }, { status: 404 });
    }
    return NextResponse.json({ error: '이력서 삭제에 실패했습니다' }, { status: 500 });
  }
}
