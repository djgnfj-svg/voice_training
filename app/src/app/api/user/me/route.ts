import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: '로그인이 필요합니다.' }, { status: 401 });
  }

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { hashedPassword: true },
  });

  return NextResponse.json({
    hasCredentials: !!user?.hashedPassword,
  });
}
