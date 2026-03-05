import { PrismaClient } from '@prisma/client';
import csBasics from '../src/data/questions/cs-basics.json';
import javascript from '../src/data/questions/javascript.json';
import react from '../src/data/questions/react.json';
import nextjs from '../src/data/questions/nextjs.json';
import typescriptAdvanced from '../src/data/questions/typescript-advanced.json';
import databaseAdvanced from '../src/data/questions/database-advanced.json';
import devops from '../src/data/questions/devops.json';

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

  console.log('Seeding complete!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
