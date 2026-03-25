import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import csBasics from '../../backend/app/data/questions/cs-basics.json';
import javascript from '../../backend/app/data/questions/javascript.json';
import react from '../../backend/app/data/questions/react.json';
import nextjs from '../../backend/app/data/questions/nextjs.json';
import typescriptAdvanced from '../../backend/app/data/questions/typescript-advanced.json';
import databaseAdvanced from '../../backend/app/data/questions/database-advanced.json';
import devops from '../../backend/app/data/questions/devops.json';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding question bank...');

  const questionSets = [csBasics, javascript, react, nextjs, typescriptAdvanced, databaseAdvanced, devops];

  for (const set of questionSets) {
    for (const q of set.questions) {
      await prisma.questionBank.upsert({
        where: {
          id: `${set.category}_${q.subcategory}_${q.questionText.slice(0, 50)}`,
        },
        update: {},
        create: {
          category: set.category,
          subcategory: q.subcategory,
          difficulty: q.difficulty as 'BEGINNER' | 'INTERMEDIATE' | 'ADVANCED',
          questionText: q.questionText,
          keyPoints: q.keyPoints,
        },
      });
    }
  }

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
        creditBalance: 100,
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
