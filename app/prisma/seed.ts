import { PrismaClient } from '@prisma/client';
import csBasics from '../src/data/questions/cs-basics.json';
import javascript from '../src/data/questions/javascript.json';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding question bank...');

  const questionSets = [csBasics, javascript];

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

  console.log('Seeding complete!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
