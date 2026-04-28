import { Injectable, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

@Injectable()
export class GlossaryService {
  private readonly logger = new Logger(GlossaryService.name);

  async translateTerm(japaneseContext: string, category: string, tenantId: string): Promise<{ english: string, confidence: number } | null> {
    // Look up term
    const entry = await prisma.glossaryEntry.findFirst({
      where: {
        category,
        japanese: japaneseContext,
        tenantId: { in: [tenantId, null] }
      },
      orderBy: { priority: 'desc' }
    });

    if (entry) {
      return { english: entry.english, confidence: 1.0 };
    }
    return null;
  }
}
