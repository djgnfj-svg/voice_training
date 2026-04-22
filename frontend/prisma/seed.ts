import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  // 테스트 계정 생성
  const testEmail = 'test@voiceprep.kr';
  const existing = await prisma.user.findUnique({ where: { email: testEmail } });
  if (!existing) {
    const hashedPassword = await bcrypt.hash('test1234', 12);
    await prisma.user.create({
      data: {
        email: testEmail,
        name: '면접관 테스트',
        hashedPassword,
      },
    });
    console.log(`테스트 계정 생성: ${testEmail} / test1234`);
  } else {
    console.log(`테스트 계정 이미 존재: ${testEmail}`);
  }

  console.log('Seeding complete!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
