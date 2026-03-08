import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import bcrypt from 'bcryptjs';
import { z } from 'zod';

const passwordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8, '새 비밀번호는 8자 이상이어야 합니다.'),
});

export async function PATCH(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: '로그인이 필요합니다.' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: '잘못된 요청입니다.' }, { status: 400 });
  }

  const parsed = passwordSchema.safeParse(body);
  if (!parsed.success) {
    const msg = parsed.error.errors[0]?.message || '입력값이 올바르지 않습니다.';
    return NextResponse.json({ error: msg }, { status: 400 });
  }

  const { currentPassword, newPassword } = parsed.data;

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { hashedPassword: true },
  });

  if (!user?.hashedPassword) {
    return NextResponse.json(
      { error: '현재 비밀번호가 올바르지 않습니다.' },
      { status: 400 }
    );
  }

  const isValid = await bcrypt.compare(currentPassword, user.hashedPassword);
  if (!isValid) {
    return NextResponse.json(
      { error: '현재 비밀번호가 올바르지 않습니다.' },
      { status: 400 }
    );
  }

  const hashedPassword = await bcrypt.hash(newPassword, 12);
  await prisma.user.update({
    where: { id: session.user.id },
    data: { hashedPassword },
  });

  return NextResponse.json({ message: '비밀번호가 변경되었습니다.' });
}
