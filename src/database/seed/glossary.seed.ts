import { PrismaClient } from '@prisma/client';
import * as seedData from '../../../dictionaries/glossary-seed.json';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding glossary entries...');

  for (const entry of seedData) {
    await prisma.glossaryEntry.upsert({
      where: {
        tenantId_category_japanese: {
          tenantId: null as any, // global entries
          category: entry.category,
          japanese: entry.japanese,
        },
      },
      update: {
        english: entry.english,
        priority: entry.priority || 0,
        isLocked: (entry as any).isLocked || false,
      },
      create: {
        tenantId: null,
        category: entry.category,
        japanese: entry.japanese,
        english: entry.english,
        priority: entry.priority || 0,
        isLocked: (entry as any).isLocked || false,
      },
    });
  }

  console.log(`Seeded ${seedData.length} glossary entries.`);
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error(e);
    prisma.$disconnect();
    process.exit(1);
  });
